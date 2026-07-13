import { describe, expect, test } from "bun:test";
import {
  QuotaRepositoryError,
  type QuotaRepository,
} from "../src/db/quota-repository";
import {
  PUBLIC_GENERATION_ERROR_CODES,
  SETTLEMENT_ERROR_CODES,
  selectSettlementErrorCode,
  type RequestStatus,
} from "../src/domain/public-generation";
import { createQuotaService } from "../src/services/quota-service";

function fakeRepository(overrides: Partial<QuotaRepository> = {}): QuotaRepository {
  return {
    reserveQuota: async () => ({ kind: "reserved", requestId: "request", status: "reserved" }),
    claimForExecution: async () => ({ kind: "claimed", requestId: "request", status: "running" }),
    settleQuota: async () => ({
      kind: "settled",
      status: "completed",
      counts: { successCount: 1, reservedCount: 0 },
    }),
    findExpiredCandidates: async () => [],
    expireById: async () => "skipped",
    ...overrides,
  };
}

describe("quota domain", () => {
  test("公开领域包含幂等冲突和请求状态", () => {
    expect(PUBLIC_GENERATION_ERROR_CODES).toContain("IDEMPOTENCY_CONFLICT");
    const status: RequestStatus = "running";
    expect(status).toBe("running");
  });

  test("结算错误码只包含受控子集", () => {
    expect(SETTLEMENT_ERROR_CODES).toEqual([
      "PROVIDER_REJECTED",
      "PROVIDER_TIMEOUT",
      "SERVICE_UNAVAILABLE",
    ]);
  });

  test("请求级错误码按固定优先级聚合", () => {
    expect(selectSettlementErrorCode([
      "PROVIDER_REJECTED",
      "PROVIDER_TIMEOUT",
    ])).toBe("PROVIDER_TIMEOUT");
    expect(selectSettlementErrorCode([
      "PROVIDER_TIMEOUT",
      "SERVICE_UNAVAILABLE",
      "PROVIDER_REJECTED",
    ])).toBe("SERVICE_UNAVAILABLE");
    expect(selectSettlementErrorCode([
      "PROVIDER_REJECTED",
      "SERVICE_UNAVAILABLE",
      "PROVIDER_TIMEOUT",
    ])).toBe("SERVICE_UNAVAILABLE");
    expect(selectSettlementErrorCode([])).toBeUndefined();
  });
});

describe("quota service sweep", () => {
  test("单条一致性错误继续处理后续候选", async () => {
    const calls: string[] = [];
    const limits: number[] = [];
    const logs: unknown[][] = [];
    const service = createQuotaService({
      repository: fakeRepository({
        findExpiredCandidates: async ({ limit }) => {
          limits.push(limit);
          return [
            { requestId: "bad" },
            { requestId: "expired" },
            { requestId: "skipped" },
          ];
        },
        expireById: async ({ requestId }) => {
          calls.push(requestId);
          if (requestId === "bad") throw new QuotaRepositoryError("INCONSISTENT", requestId);
          return requestId === "expired" ? "expired" : "skipped";
        },
      }),
      deviceLimit: 10,
      ipLimit: 30,
      logger: { error: (...args: unknown[]) => logs.push(args) },
    });

    await expect(service.expireReservations(new Date())).resolves.toEqual({
      expired: 1,
      skipped: 1,
      inconsistent: 1,
    });
    expect(limits).toEqual([100]);
    expect(calls).toEqual(["bad", "expired", "skipped"]);
    expect(logs).toEqual([[
      "Quota reservation consistency error",
      { requestId: "bad", stage: "expire" },
    ]]);
  });

  test("系统错误立即中止本轮且不记录原始错误", async () => {
    const calls: string[] = [];
    const logs: unknown[][] = [];
    const service = createQuotaService({
      repository: fakeRepository({
        findExpiredCandidates: async () => [
          { requestId: "first" },
          { requestId: "second" },
        ],
        expireById: async ({ requestId }) => {
          calls.push(requestId);
          throw new Error("database details must not be logged");
        },
      }),
      deviceLimit: 10,
      ipLimit: 30,
      logger: { error: (...args: unknown[]) => logs.push(args) },
    });

    await expect(service.expireReservations(new Date()))
      .rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(calls).toEqual(["first"]);
    expect(logs).toEqual([]);
  });
});
