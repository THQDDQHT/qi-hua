import type { Hono } from "hono";
import type { Sql } from "postgres";
import type { AppEnv } from "../app";
import { formatQuotaSnapshot, readCurrentDeviceQuota } from "../services/quota-snapshot";

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

export function registerSessionRoutes(app: Hono<AppEnv>, sql: Sql) {
  async function currentQuota(clientId: string, quotaDate: string, resetAt: string, limit: number) {
    return formatQuotaSnapshot({
      limit,
      counts: await readCurrentDeviceQuota(sql, clientId, quotaDate),
      resetAt,
    });
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
