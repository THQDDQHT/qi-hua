import type { Sql } from "postgres";
import type {
  GenerationResultManifestItem,
  PublicGenerationErrorCode,
  SettlementErrorCode,
} from "../domain/public-generation";
import { PublicGenerationError } from "../domain/public-generation";
import type { GenerationTaskRepository } from "../db/quota-repository";
import { createGenerationFingerprint, type GenerationOperation } from "./generation-fingerprint";
import type { ImageProvider } from "./image-provider";
import type { GenerationInput, ValidatedReference } from "./image-validation";
import { formatQuotaSnapshot, readCurrentDeviceQuota } from "./quota-snapshot";
import type { createQuotaService } from "./quota-service";
import type { GenerationStorage } from "./generation-storage";

type QuotaService = Pick<ReturnType<typeof createQuotaService>, "reserveQuota">;
type QueueProducer = {
  enqueue(requestId: string): Promise<unknown>;
  ping(): Promise<unknown>;
};

export type SubmissionResult = {
  taskId: string;
  status: "queued" | "running" | "completed" | "partial" | "failed" | "expired";
  replayed: boolean;
  expiresAt: string;
};

type ApiDependencies = {
  sql: Sql;
  repository: GenerationTaskRepository;
  quotaService: QuotaService;
  queue: QueueProducer;
  storage: GenerationStorage;
  idempotencySecret: string;
  reservationTtlSeconds: number;
  deviceLimit: number;
  logger?: Pick<Console, "error">;
  now?: () => Date;
};

type WorkerDependencies = {
  repository: GenerationTaskRepository;
  provider: ImageProvider;
  storage: GenerationStorage;
  upstreamTimeoutMs: number;
  executionLeaseSeconds: number;
  resultTtlSeconds: number;
  now?: () => Date;
};

function publicStatus(status: string): SubmissionResult["status"] {
  return status === "reserved" ? "queued" : status as SubmissionResult["status"];
}

function slotError(error: unknown): SettlementErrorCode {
  if (error instanceof PublicGenerationError) {
    if (
      error.code === "PROVIDER_REJECTED"
      || error.code === "PROVIDER_TIMEOUT"
      || error.code === "SERVICE_UNAVAILABLE"
    ) return error.code;
  }
  return "SERVICE_UNAVAILABLE";
}

function validTaskId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function createGenerationApiService({
  sql,
  repository,
  quotaService,
  queue,
  storage,
  idempotencySecret,
  reservationTtlSeconds,
  deviceLimit,
  logger = console,
  now = () => new Date(),
}: ApiDependencies) {
  async function submit(input: {
    operation: GenerationOperation;
    generation: GenerationInput;
    references: readonly ValidatedReference[];
    clientId: string;
    ipHash: Uint8Array;
    quotaDate: string;
  }): Promise<SubmissionResult> {
    const requestId = crypto.randomUUID();
    let referenceManifest;
    try {
      if (input.operation === "edit") {
        const [reference] = input.references;
        if (!reference) throw new PublicGenerationError("INVALID_IMAGE");
        referenceManifest = await storage.writeReference(requestId, reference);
      }
      const startedAt = now();
      const reservation = await quotaService.reserveQuota({
        requestId,
        clientId: input.clientId,
        requestKey: input.generation.requestKey,
        payloadFingerprint: createGenerationFingerprint({
          secret: idempotencySecret,
          operation: input.operation,
          generation: input.generation,
          references: input.references,
        }),
        ipHash: input.ipHash,
        quotaDate: input.quotaDate,
        requestedCount: input.generation.count,
        expiresAt: new Date(startedAt.getTime() + reservationTtlSeconds * 1000),
        task: {
          operation: input.operation,
          prompt: input.generation.prompt,
          size: input.generation.size,
          quality: input.generation.quality,
          ...(referenceManifest ? { referenceManifest } : {}),
        },
      });

      if (reservation.requestId !== requestId) await storage.removeRequest(requestId);
      if (reservation.status === "reserved" || reservation.status === "running") {
        try {
          await queue.enqueue(reservation.requestId);
        } catch {
          logger.error("Generation queue dispatch deferred", { requestId: reservation.requestId });
        }
      }
      return {
        taskId: reservation.requestId,
        status: publicStatus(reservation.status),
        replayed: reservation.kind === "replay",
        expiresAt: reservation.expiresAt.toISOString(),
      };
    } catch (error) {
      await storage.removeRequest(requestId).catch(() => undefined);
      throw error;
    }
  }

  async function getTask(input: {
    requestId: string;
    clientId: string;
    quotaDate: string;
    resetAt: string;
  }) {
    if (!validTaskId(input.requestId)) throw new PublicGenerationError("TASK_NOT_FOUND");
    const task = await repository.findTaskForClient(input);
    if (!task) throw new PublicGenerationError("TASK_NOT_FOUND");
    const resultsAvailable = !task.artifactsDeletedAt
      && (!task.resultExpiresAt || task.resultExpiresAt.getTime() > now().getTime());
    const results = (task.resultManifest ?? []).map((result) => result.status === "success"
      ? {
          index: result.index,
          status: "success" as const,
          ...(resultsAvailable ? {
            image: {
              mimeType: result.mimeType,
              url: `/api/images/tasks/${task.requestId}/results/${result.index}`,
            },
          } : {}),
        }
      : result);
    const terminal = ["completed", "partial", "failed", "expired"].includes(task.status);
    return {
      taskId: task.requestId,
      status: publicStatus(task.status),
      expiresAt: task.expiresAt.toISOString(),
      ...(terminal ? {
        results,
        resultsExpired: !resultsAvailable,
        quota: formatQuotaSnapshot({
          limit: deviceLimit,
          counts: await readCurrentDeviceQuota(sql, input.clientId, input.quotaDate),
          resetAt: input.resetAt,
        }),
      } : {}),
    };
  }

  async function getResult(input: { requestId: string; clientId: string; index: number }) {
    if (!validTaskId(input.requestId) || !Number.isSafeInteger(input.index)) {
      throw new PublicGenerationError("TASK_NOT_FOUND");
    }
    const task = await repository.findTaskForClient(input);
    if (!task) throw new PublicGenerationError("TASK_NOT_FOUND");
    if (
      task.artifactsDeletedAt
      || !task.resultExpiresAt
      || task.resultExpiresAt.getTime() <= now().getTime()
    ) throw new PublicGenerationError("RESULT_EXPIRED");
    const result = task.resultManifest?.find((item) => (
      item.index === input.index && item.status === "success"
    ));
    if (!result || result.status !== "success") throw new PublicGenerationError("TASK_NOT_FOUND");
    return { file: await storage.openResult(task.requestId, result), mimeType: result.mimeType };
  }

  async function dispatchPending(limit = 100) {
    const candidates = await repository.findDispatchCandidates({ now: now(), limit });
    let dispatched = 0;
    for (const candidate of candidates) {
      try {
        await queue.enqueue(candidate.requestId);
        dispatched++;
      } catch {
        logger.error("Generation queue dispatch deferred", { requestId: candidate.requestId });
      }
    }
    return { candidates: candidates.length, dispatched };
  }

  async function cleanupExpiredArtifacts(limit = 100) {
    const timestamp = now();
    const candidates = await repository.findArtifactCleanupCandidates({ now: timestamp, limit });
    let deleted = 0;
    for (const candidate of candidates) {
      try {
        await storage.removeRequest(candidate.requestId);
        await repository.markArtifactsDeleted({ requestId: candidate.requestId, now: timestamp });
        deleted++;
      } catch {
        logger.error("Generation artifact cleanup deferred", { requestId: candidate.requestId });
      }
    }
    let orphaned = 0;
    const staleDirectories = await storage.findStaleRequestDirectories(
      new Date(timestamp.getTime() - reservationTtlSeconds * 1000),
      limit,
    );
    for (const requestId of staleDirectories) {
      if (await repository.requestExists(requestId)) continue;
      await storage.removeRequest(requestId);
      orphaned++;
    }
    return { candidates: candidates.length, deleted, orphaned };
  }

  async function checkReady() {
    await Promise.all([queue.ping(), storage.checkReady()]);
  }

  return { submit, getTask, getResult, dispatchPending, cleanupExpiredArtifacts, checkReady };
}

export function createGenerationWorkerProcessor({
  repository,
  provider,
  storage,
  upstreamTimeoutMs,
  executionLeaseSeconds,
  resultTtlSeconds,
  now = () => new Date(),
}: WorkerDependencies) {
  return async function process(input: { requestId: string }) {
    if (!validTaskId(input.requestId)) throw new Error("invalid generation job");
    const executionId = crypto.randomUUID();
    const claimedAt = now();
    const claim = await repository.claimTaskExecution({
      requestId: input.requestId,
      executionId,
      now: claimedAt,
      leaseUntil: new Date(claimedAt.getTime() + executionLeaseSeconds * 1000),
    });
    if (claim.kind !== "claimed") return;

    let lostLease = false;
    let heartbeatPending: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = (async () => {
        const timestamp = now();
        try {
          lostLease = !(await repository.heartbeatTaskExecution({
            requestId: input.requestId,
            executionId,
            now: timestamp,
            leaseUntil: new Date(timestamp.getTime() + executionLeaseSeconds * 1000),
          }));
        } catch {
          lostLease = true;
        }
      })().finally(() => {
        heartbeatPending = undefined;
      });
    }, Math.max(1000, Math.floor(executionLeaseSeconds * 1000 / 3)));
    heartbeat.unref?.();

    try {
      const references = claim.task.operation === "edit" && claim.task.referenceManifest
        ? [await storage.readReference(claim.task.requestId, claim.task.referenceManifest)]
        : [];
      const results: GenerationResultManifestItem[] = [];
      for (let index = 0; index < claim.task.requestedCount; index++) {
        if (lostLease) throw new Error("generation execution lease lost");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
        try {
          const image = claim.task.operation === "edit"
            ? await provider.editSlot({
                prompt: claim.task.prompt,
                size: claim.task.size,
                quality: claim.task.quality,
                references,
                signal: controller.signal,
              })
            : await provider.generateSlot({
                prompt: claim.task.prompt,
                size: claim.task.size,
                quality: claim.task.quality,
                signal: controller.signal,
              });
          if (lostLease) throw new Error("generation execution lease lost");
          results.push(await storage.writeResult(input.requestId, executionId, index, image));
        } catch (error) {
          if (!(error instanceof PublicGenerationError)) throw error;
          results.push({ index, status: "failed", errorCode: slotError(error) });
        } finally {
          clearTimeout(timer);
        }
      }

      const completedAt = now();
      const settlement = await repository.settleTaskExecution({
        requestId: input.requestId,
        executionId,
        results,
        now: completedAt,
        resultExpiresAt: new Date(completedAt.getTime() + resultTtlSeconds * 1000),
      });
      if (settlement.kind === "stale") await storage.removeExecution(input.requestId, executionId);
    } catch (error) {
      clearInterval(heartbeat);
      await heartbeatPending;
      await repository.abandonTaskExecution({
        requestId: input.requestId,
        executionId,
        now: now(),
      }).catch(() => undefined);
      await storage.removeExecution(input.requestId, executionId).catch(() => undefined);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  };
}

export function errorStatus(code: PublicGenerationErrorCode) {
  if (code === "TASK_NOT_FOUND") return 404 as const;
  if (code === "RESULT_EXPIRED") return 410 as const;
  if (code === "IDEMPOTENCY_CONFLICT") return 409 as const;
  if (code === "QUOTA_EXHAUSTED" || code === "IP_QUOTA_EXHAUSTED" || code === "RATE_LIMITED") return 429 as const;
  if (code === "REQUEST_TOO_LARGE") return 413 as const;
  if (code === "PUBLIC_GENERATION_OFF" || code === "SERVICE_UNAVAILABLE") return 503 as const;
  if (code === "PROVIDER_TIMEOUT") return 504 as const;
  if (code === "PROVIDER_REJECTED") return 502 as const;
  return 400 as const;
}
