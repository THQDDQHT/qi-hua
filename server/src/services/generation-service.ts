import type { PublicGenerationErrorCode, SettlementErrorCode } from "../domain/public-generation";
import { PublicGenerationError, selectSettlementErrorCode } from "../domain/public-generation";
import type { QuotaSnapshot } from "./quota-snapshot";
import type { ImageProvider, ProviderImage } from "./image-provider";
import type { GenerationInput, ValidatedReference } from "./image-validation";
import { createGenerationFingerprint, type GenerationOperation } from "./generation-fingerprint";
import type { createQuotaService } from "./quota-service";

export type GenerationSlotResult =
  | { index: number; status: "success"; image: ProviderImage }
  | {
      index: number;
      status: "failed";
      errorCode: "PROVIDER_REJECTED" | "PROVIDER_TIMEOUT" | "SERVICE_UNAVAILABLE";
    };

export type GenerationBatchResult = {
  status: "completed" | "partial" | "failed";
  replayed: boolean;
  results: GenerationSlotResult[];
  quota: QuotaSnapshot;
};

export type GenerationInProgressResult = {
  status: "running";
  replayed: true;
};

type QuotaService = ReturnType<typeof createQuotaService>;

type Dependencies = {
  quotaService: QuotaService;
  provider: ImageProvider;
  idempotencySecret: string;
  reservationTtlSeconds: number;
  upstreamTimeoutMs: number;
  now?: () => Date;
};

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

export function createGenerationService({
  quotaService,
  provider,
  idempotencySecret,
  reservationTtlSeconds,
  upstreamTimeoutMs,
  now = () => new Date(),
}: Dependencies) {
  async function execute(input: {
    operation: GenerationOperation;
    generation: GenerationInput;
    references: readonly ValidatedReference[];
    clientId: string;
    ipHash: Uint8Array;
    quotaDate: string;
  }): Promise<GenerationBatchResult | GenerationInProgressResult> {
    const startedAt = now();
    const fingerprint = createGenerationFingerprint({
      secret: idempotencySecret,
      operation: input.operation,
      generation: input.generation,
      references: input.references,
    });
    const reservation = await quotaService.reserveQuota({
      clientId: input.clientId,
      requestKey: input.generation.requestKey,
      payloadFingerprint: fingerprint,
      ipHash: input.ipHash,
      quotaDate: input.quotaDate,
      requestedCount: input.generation.count,
      expiresAt: new Date(startedAt.getTime() + reservationTtlSeconds * 1000),
    });

    if (reservation.kind === "replay" && reservation.status !== "reserved") {
      if (reservation.status === "running") return { status: "running", replayed: true };
      const settled = await quotaService.settleQuota({ requestId: reservation.requestId, successCount: 0, now: now() });
      return {
        status: settled.status === "expired" ? "failed" : settled.status,
        replayed: true,
        results: [],
        quota: settled.quota,
      };
    }

    const claim = await quotaService.claimForExecution({ requestId: reservation.requestId, now: now() });
    if (claim.kind === "not-claimed") {
      if (claim.status === "running") return { status: "running", replayed: true };
      const settled = await quotaService.settleQuota({ requestId: reservation.requestId, successCount: 0, now: now() });
      return {
        status: settled.status === "expired" ? "failed" : settled.status,
        replayed: true,
        results: [],
        quota: settled.quota,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    const references = input.references.map((reference) => reference.file);
    const slots = Array.from({ length: input.generation.count }, (_, index) => (async (): Promise<GenerationSlotResult> => {
      try {
        const image = input.operation === "edit"
          ? await provider.editSlot({
              prompt: input.generation.prompt,
              size: input.generation.size,
              quality: input.generation.quality,
              references,
              signal: controller.signal,
            })
          : await provider.generateSlot({
              prompt: input.generation.prompt,
              size: input.generation.size,
              quality: input.generation.quality,
              signal: controller.signal,
            });
        return { index, status: "success", image };
      } catch (error) {
        return { index, status: "failed", errorCode: slotError(error) };
      }
    })());

    let results: GenerationSlotResult[];
    try {
      results = (await Promise.allSettled(slots)).map((result, index) => {
        if (result.status === "fulfilled") return result.value;
        return { index, status: "failed", errorCode: "SERVICE_UNAVAILABLE" };
      });
    } finally {
      clearTimeout(timer);
    }

    const successCount = results.filter((result) => result.status === "success").length;
    const errorCode = selectSettlementErrorCode(
      results.flatMap((result) => result.status === "failed" ? [result.errorCode] : []),
    );
    const settlement = await quotaService.settleQuota({
      requestId: reservation.requestId,
      successCount,
      errorCode,
      now: now(),
    });

    if (settlement.kind !== "settled") {
      return {
        status: settlement.status === "expired" ? "failed" : settlement.status,
        replayed: true,
        results: [],
        quota: settlement.quota,
      };
    }

    return {
      status: settlement.status,
      replayed: false,
      results,
      quota: settlement.quota,
    };
  }

  return { execute };
}

export function errorStatus(code: PublicGenerationErrorCode) {
  if (code === "IDEMPOTENCY_CONFLICT") return 409 as const;
  if (code === "QUOTA_EXHAUSTED" || code === "IP_QUOTA_EXHAUSTED" || code === "RATE_LIMITED") return 429 as const;
  if (code === "REQUEST_TOO_LARGE") return 413 as const;
  if (code === "PUBLIC_GENERATION_OFF" || code === "SERVICE_UNAVAILABLE") return 503 as const;
  if (code === "PROVIDER_TIMEOUT") return 504 as const;
  if (code === "PROVIDER_REJECTED") return 502 as const;
  return 400 as const;
}
