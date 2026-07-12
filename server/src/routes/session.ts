import type { Hono } from "hono";
import type { Sql } from "postgres";
import type { AppEnv } from "../app";

export type PublicSessionResponse = {
  mode: "public";
  quota: { limit: number; used: number; reserved: number; remaining: number; resetAt: string };
  generation: {
    modelLabel: string;
    counts: number[];
    sizes: string[];
    qualities: string[];
    maxPromptLength: number;
    maxReferenceImages: number;
  };
};

export function getShanghaiQuotaWindow(now: Date) {
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
  const resetDate = nextDate.toISOString().slice(0, 10);
  return { quotaDate, resetAt: new Date(`${resetDate}T00:00:00+08:00`).toISOString() };
}

export function registerSessionRoutes(app: Hono<AppEnv>, sql: Sql) {
  async function currentQuota(clientId: string, quotaDate: string, resetAt: string, limit: number) {
    const current = (await sql<{ used: number; reserved: number }[]>`
      select success_count as used, reserved_count as reserved
      from daily_client_quotas
      where client_id = ${clientId} and quota_date = ${quotaDate}
    `)[0] ?? { used: 0, reserved: 0 };
    return {
      limit,
      ...current,
      remaining: Math.max(0, limit - current.used - current.reserved),
      resetAt,
    };
  }

  app.get("/api/session", async (context) => {
    const config = context.get("config");
    const quota = await currentQuota(
      context.get("clientId"),
      context.get("quotaDate"),
      context.get("resetAt"),
      config.dailyDeviceLimit,
    );
    const response: PublicSessionResponse = {
      mode: "public",
      quota,
      generation: {
        modelLabel: "免费生图模型",
        counts: [1, 2, 3, 4],
        sizes: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"],
        qualities: ["auto", "high", "medium", "low"],
        maxPromptLength: 4000,
        maxReferenceImages: 4,
      },
    };
    return context.json(response);
  });

  app.get("/api/quota", async (context) => {
    const config = context.get("config");
    return context.json(await currentQuota(
      context.get("clientId"),
      context.get("quotaDate"),
      context.get("resetAt"),
      config.dailyDeviceLimit,
    ));
  });
}
