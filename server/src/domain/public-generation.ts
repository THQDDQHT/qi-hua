export const PUBLIC_GENERATION_ERROR_CODES = [
  "QUOTA_EXHAUSTED",
  "IP_QUOTA_EXHAUSTED",
  "IDEMPOTENCY_CONFLICT",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "INVALID_IMAGE",
  "REQUEST_TOO_LARGE",
  "PROVIDER_REJECTED",
  "PROVIDER_TIMEOUT",
  "SERVICE_UNAVAILABLE",
  "PUBLIC_GENERATION_OFF",
] as const;

export type PublicGenerationErrorCode = (typeof PUBLIC_GENERATION_ERROR_CODES)[number];

export const REQUEST_STATUSES = [
  "reserved",
  "running",
  "completed",
  "partial",
  "failed",
  "expired",
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const SETTLEMENT_ERROR_CODES = [
  "PROVIDER_REJECTED",
  "PROVIDER_TIMEOUT",
  "SERVICE_UNAVAILABLE",
] as const;

export type SettlementErrorCode = (typeof SETTLEMENT_ERROR_CODES)[number];

const SETTLEMENT_ERROR_PRIORITY: Record<SettlementErrorCode, number> = {
  PROVIDER_REJECTED: 1,
  PROVIDER_TIMEOUT: 2,
  SERVICE_UNAVAILABLE: 3,
};

export function selectSettlementErrorCode(
  errorCodes: readonly SettlementErrorCode[],
): SettlementErrorCode | undefined {
  return errorCodes.reduce<SettlementErrorCode | undefined>((selected, errorCode) => {
    if (!selected || SETTLEMENT_ERROR_PRIORITY[errorCode] > SETTLEMENT_ERROR_PRIORITY[selected]) {
      return errorCode;
    }
    return selected;
  }, undefined);
}
