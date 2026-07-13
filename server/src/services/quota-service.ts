import type {
  QuotaRepository,
  ReservationRecord,
  ClaimRecord,
} from "../db/quota-repository";
import { QuotaRepositoryError } from "../db/quota-repository";
import type {
  PublicGenerationErrorCode,
  RequestStatus,
  SettlementErrorCode,
} from "../domain/public-generation";
import {
  formatQuotaSnapshot,
  getShanghaiQuotaWindow,
  type QuotaSnapshot,
} from "./quota-snapshot";

export type ReserveQuotaInput = {
  clientId: string;
  requestKey: string;
  payloadFingerprint: Uint8Array;
  ipHash: Uint8Array;
  quotaDate: string;
  requestedCount: number;
  expiresAt: Date;
};

export type Reservation = ReservationRecord;
export type ClaimResult = ClaimRecord;

export type SettleQuotaInput = {
  requestId: string;
  successCount: number;
  errorCode?: SettlementErrorCode;
  now: Date;
};

export type SettlementResult =
  | {
      kind: "settled";
      status: "completed" | "partial" | "failed";
      quota: QuotaSnapshot;
    }
  | {
      kind: "already-settled";
      status: "completed" | "partial" | "failed";
      quota: QuotaSnapshot;
    }
  | { kind: "expired"; status: "expired"; quota: QuotaSnapshot };

export type ExpirationSweepResult = {
  expired: number;
  skipped: number;
  inconsistent: number;
};

export class QuotaServiceError extends Error {
  constructor(readonly code: PublicGenerationErrorCode) {
    super(code);
    this.name = "QuotaServiceError";
  }
}

type Dependencies = {
  repository: QuotaRepository;
  deviceLimit: number;
  ipLimit: number;
  logger?: Pick<Console, "error">;
};

function validRequestedCount(value: number) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 4;
}

export function createQuotaService({
  repository,
  deviceLimit,
  ipLimit,
  logger = console,
}: Dependencies) {
  function handleRepositoryError(error: unknown): never {
    if (error instanceof QuotaRepositoryError) {
      if (error.code === "DEVICE_QUOTA") throw new QuotaServiceError("QUOTA_EXHAUSTED");
      if (error.code === "IP_QUOTA") throw new QuotaServiceError("IP_QUOTA_EXHAUSTED");
      if (error.code === "IDEMPOTENCY_CONFLICT") {
        throw new QuotaServiceError("IDEMPOTENCY_CONFLICT");
      }
      if (error.code === "INVALID_INPUT") throw new QuotaServiceError("INVALID_REQUEST");
      logger.error("Quota counter consistency error", { requestId: error.requestId });
    }
    throw new QuotaServiceError("SERVICE_UNAVAILABLE");
  }

  async function reserveQuota(input: ReserveQuotaInput): Promise<Reservation> {
    if (!validRequestedCount(input.requestedCount) || input.payloadFingerprint.byteLength !== 32) {
      throw new QuotaServiceError("INVALID_REQUEST");
    }
    try {
      return await repository.reserveQuota(input, { deviceLimit, ipLimit });
    } catch (error) {
      handleRepositoryError(error);
    }
  }

  async function claimForExecution(input: {
    requestId: string;
    now: Date;
  }): Promise<ClaimResult> {
    try {
      return await repository.claimForExecution(input);
    } catch (error) {
      handleRepositoryError(error);
    }
  }

  async function settleQuota(input: SettleQuotaInput): Promise<SettlementResult> {
    const window = getShanghaiQuotaWindow(input.now);
    try {
      const result = await repository.settleQuota({
        ...input,
        currentQuotaDate: window.quotaDate,
      });
      return {
        kind: result.kind,
        status: result.status,
        quota: formatQuotaSnapshot({
          limit: deviceLimit,
          counts: result.counts,
          resetAt: window.resetAt,
        }),
      } as SettlementResult;
    } catch (error) {
      handleRepositoryError(error);
    }
  }

  async function expireReservations(now: Date): Promise<ExpirationSweepResult> {
    let expired = 0;
    let skipped = 0;
    let inconsistent = 0;
    let candidates: Array<{ requestId: string }>;
    try {
      candidates = await repository.findExpiredCandidates({ now, limit: 100 });
    } catch (error) {
      handleRepositoryError(error);
    }

    for (const { requestId } of candidates) {
      try {
        const result = await repository.expireById({ requestId, now });
        if (result === "expired") expired++;
        else skipped++;
      } catch (error) {
        if (error instanceof QuotaRepositoryError && error.code === "INCONSISTENT") {
          inconsistent++;
          logger.error("Quota reservation consistency error", { requestId, stage: "expire" });
          continue;
        }
        handleRepositoryError(error);
      }
    }
    return { expired, skipped, inconsistent };
  }

  return { reserveQuota, claimForExecution, settleQuota, expireReservations };
}

export type { QuotaSnapshot, RequestStatus };
