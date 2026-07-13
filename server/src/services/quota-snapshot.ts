import type { Sql, TransactionSql } from "postgres";

export type QuotaCounts = {
  successCount: number;
  reservedCount: number;
};

export type QuotaWindow = {
  quotaDate: string;
  resetAt: string;
};

export type QuotaSnapshot = {
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  resetAt: string;
};

export function getShanghaiQuotaWindow(now: Date): QuotaWindow {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const quotaDate = `${value("year")}-${value("month")}-${value("day")}`;
  const nextDate = new Date(`${quotaDate}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return {
    quotaDate,
    resetAt: new Date(`${nextDate.toISOString().slice(0, 10)}T00:00:00+08:00`).toISOString(),
  };
}

export async function readCurrentDeviceQuota(
  sql: Sql | TransactionSql,
  clientId: string,
  quotaDate: string,
): Promise<QuotaCounts> {
  return (await sql<QuotaCounts[]>`
    select success_count as "successCount", reserved_count as "reservedCount"
    from daily_client_quotas
    where client_id = ${clientId} and quota_date = ${quotaDate}
  `)[0] ?? { successCount: 0, reservedCount: 0 };
}

export function formatQuotaSnapshot(input: {
  limit: number;
  counts: QuotaCounts;
  resetAt: string;
}): QuotaSnapshot {
  return {
    limit: input.limit,
    used: input.counts.successCount,
    reserved: input.counts.reservedCount,
    remaining: Math.max(0, input.limit - input.counts.successCount - input.counts.reservedCount),
    resetAt: input.resetAt,
  };
}
