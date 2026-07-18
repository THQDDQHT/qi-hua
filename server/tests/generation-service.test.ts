import { describe, expect, test } from "bun:test";
import { PublicGenerationError } from "../src/domain/public-generation";
import {
  createGenerationApiService,
  createGenerationWorkerProcessor,
} from "../src/services/generation-service";
import type { ImageProvider, ProviderImage } from "../src/services/image-provider";
import type { GenerationStorage } from "../src/services/generation-storage";

const requestId = "00000000-0000-4000-8000-000000000001";
const executionId = "00000000-0000-4000-8000-000000000002";
const expiresAt = new Date("2040-01-02T08:00:00.000Z");

function storage(overrides: Partial<GenerationStorage> = {}): GenerationStorage {
  return {
    writeReference: async () => ({ filename: "reference.png", mimeType: "image/png" }),
    readReference: async () => new File(["reference"], "reference.png", { type: "image/png" }),
    writeResult: async (_requestId, execution, index, image) => ({
      index,
      status: "success",
      filename: `executions/${execution}/${index}.png`,
      mimeType: image.mimeType,
    }),
    openResult: async () => Bun.file(import.meta.path),
    removeRequest: async () => undefined,
    removeExecution: async () => undefined,
    checkReady: async () => undefined,
    findStaleRequestDirectories: async () => [],
    ...overrides,
  };
}

function taskRepository(overrides: Record<string, unknown> = {}) {
  return {
    findTaskForClient: async () => undefined,
    requestExists: async () => false,
    findDispatchCandidates: async () => [],
    claimTaskExecution: async () => ({
      kind: "claimed",
      executionId,
      task: {
        requestId,
        clientId: "client-id",
        status: "running",
        operation: "generation",
        prompt: "一只猫",
        requestedCount: 1,
        size: "1:1",
        quality: "high",
        expiresAt,
      },
    }),
    heartbeatTaskExecution: async () => true,
    abandonTaskExecution: async () => undefined,
    settleTaskExecution: async () => ({ kind: "settled", status: "completed" }),
    findArtifactCleanupCandidates: async () => [],
    markArtifactsDeleted: async () => undefined,
    ...overrides,
  };
}

const generation = {
  requestKey: "request-key",
  prompt: "一只猫",
  count: 1,
  size: "1:1" as const,
  quality: "high" as const,
};

describe("异步任务提交", () => {
  test("Redis 暂时不可用仍返回已提交到 PostgreSQL 的任务", async () => {
    const logs: unknown[][] = [];
    const service = createGenerationApiService({
      sql: {} as never,
      repository: taskRepository() as never,
      quotaService: {
        reserveQuota: async () => ({
          kind: "reserved",
          requestId,
          status: "reserved",
          expiresAt,
        }),
      },
      queue: {
        enqueue: async () => { throw new Error("private redis details"); },
        ping: async () => "PONG",
      },
      storage: storage(),
      idempotencySecret: "idempotency-test-secret".padEnd(32, "x"),
      reservationTtlSeconds: 21600,
      deviceLimit: 10,
      logger: { error: (...args: unknown[]) => logs.push(args) },
      now: () => new Date("2040-01-02T02:00:00.000Z"),
    });

    await expect(service.submit({
      operation: "generation",
      generation,
      references: [],
      clientId: "client-id",
      ipHash: new Uint8Array(32),
      quotaDate: "2040-01-02",
    })).resolves.toEqual({
      taskId: requestId,
      status: "queued",
      replayed: false,
      expiresAt: expiresAt.toISOString(),
    });
    expect(JSON.stringify(logs)).not.toContain("private redis details");
  });

  test("幂等重放删除未采用的候选参考图目录", async () => {
    const removed: string[] = [];
    const service = createGenerationApiService({
      sql: {} as never,
      repository: taskRepository() as never,
      quotaService: {
        reserveQuota: async () => ({ kind: "replay", requestId, status: "running", expiresAt }),
      },
      queue: { enqueue: async () => undefined, ping: async () => "PONG" },
      storage: storage({ removeRequest: async (id) => { removed.push(id); } }),
      idempotencySecret: "idempotency-test-secret".padEnd(32, "x"),
      reservationTtlSeconds: 21600,
      deviceLimit: 10,
    });
    const reference = {
      file: new File(["reference"], "reference.png", { type: "image/png" }),
      bytes: new Uint8Array([1]),
      mimeType: "image/png" as const,
      digest: new Uint8Array(32),
    };

    const result = await service.submit({
      operation: "edit",
      generation,
      references: [reference],
      clientId: "client-id",
      ipHash: new Uint8Array(32),
      quotaDate: "2040-01-02",
    });

    expect(result).toMatchObject({ taskId: requestId, status: "running", replayed: true });
    expect(removed).toHaveLength(1);
    expect(removed[0]).not.toBe(requestId);
  });

  test("终态幂等重放直接返回且不再投递 Redis", async () => {
    let enqueued = 0;
    const service = createGenerationApiService({
      sql: {} as never,
      repository: taskRepository() as never,
      quotaService: {
        reserveQuota: async () => ({ kind: "replay", requestId, status: "completed", expiresAt }),
      },
      queue: {
        enqueue: async () => { enqueued++; },
        ping: async () => "PONG",
      },
      storage: storage(),
      idempotencySecret: "idempotency-test-secret".padEnd(32, "x"),
      reservationTtlSeconds: 21600,
      deviceLimit: 10,
    });

    await expect(service.submit({
      operation: "generation",
      generation,
      references: [],
      clientId: "client-id",
      ipHash: new Uint8Array(32),
      quotaDate: "2040-01-02",
    })).resolves.toMatchObject({ taskId: requestId, status: "completed", replayed: true });
    expect(enqueued).toBe(0);
  });
});

describe("异步任务执行", () => {
  test("批次槽严格顺序执行并将供应商失败一起原子结算", async () => {
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const settled: unknown[] = [];
    const provider: ImageProvider = {
      generateSlot: async () => {
        const index = calls++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active--;
        if (index === 1) throw new PublicGenerationError("PROVIDER_TIMEOUT");
        return { mimeType: "image/png", bytes: new Uint8Array([index]) };
      },
      editSlot: async () => { throw new Error("unused"); },
    };
    const repository = taskRepository({
      claimTaskExecution: async () => ({
        kind: "claimed",
        executionId,
        task: {
          requestId,
          clientId: "client-id",
          status: "running",
          operation: "generation",
          prompt: "一只猫",
          requestedCount: 3,
          size: "1:1",
          quality: "high",
          expiresAt,
        },
      }),
      settleTaskExecution: async (input: unknown) => {
        settled.push(input);
        return { kind: "settled", status: "partial" };
      },
    });
    const process = createGenerationWorkerProcessor({
      repository: repository as never,
      provider,
      storage: storage(),
      upstreamTimeoutMs: 1000,
      executionLeaseSeconds: 300,
      resultTtlSeconds: 86400,
    });

    await process({ requestId });

    expect(maximumActive).toBe(1);
    expect(calls).toBe(3);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      requestId,
      results: [
        { index: 0, status: "success" },
        { index: 1, status: "failed", errorCode: "PROVIDER_TIMEOUT" },
        { index: 2, status: "success" },
      ],
    });
  });

  test("执行围栏失效时删除迟到执行目录", async () => {
    const removed: string[] = [];
    const provider: ImageProvider = {
      generateSlot: async (): Promise<ProviderImage> => ({
        mimeType: "image/png",
        bytes: new Uint8Array([1]),
      }),
      editSlot: async () => { throw new Error("unused"); },
    };
    const process = createGenerationWorkerProcessor({
      repository: taskRepository({
        settleTaskExecution: async () => ({ kind: "stale" }),
      }) as never,
      provider,
      storage: storage({
        removeExecution: async (id, execution) => { removed.push(`${id}/${execution}`); },
      }),
      upstreamTimeoutMs: 1000,
      executionLeaseSeconds: 300,
      resultTtlSeconds: 86400,
    });

    await process({ requestId });

    expect(removed).toHaveLength(1);
    expect(removed[0]).toStartWith(`${requestId}/`);
  });
});

describe("结果清理", () => {
  test("到期目录删除成功后才写数据库标记", async () => {
    const calls: string[] = [];
    const service = createGenerationApiService({
      sql: {} as never,
      repository: taskRepository({
        findArtifactCleanupCandidates: async () => [{ requestId }],
        markArtifactsDeleted: async () => { calls.push("mark"); },
      }) as never,
      quotaService: { reserveQuota: async () => { throw new Error("unused"); } },
      queue: { enqueue: async () => undefined, ping: async () => "PONG" },
      storage: storage({ removeRequest: async () => { calls.push("delete"); } }),
      idempotencySecret: "idempotency-test-secret".padEnd(32, "x"),
      reservationTtlSeconds: 21600,
      deviceLimit: 10,
    });

    await expect(service.cleanupExpiredArtifacts()).resolves.toEqual({
      candidates: 1,
      deleted: 1,
      orphaned: 0,
    });
    expect(calls).toEqual(["delete", "mark"]);
  });
});
