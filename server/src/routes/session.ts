import type { Hono } from "hono";
import type { Sql } from "postgres";
import type { AppEnv } from "../app";
import { GENERATION_POLICY } from "../services/image-validation";
import { formatQuotaSnapshot, readCurrentDeviceQuota } from "../services/quota-snapshot";

export type PublicSessionResponse = {
  mode: "public";
  quota: { limit: number; used: number; reserved: number; remaining: number; resetAt: string };
  generation: {
    enabled: boolean;
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
        enabled: config.publicGenerationEnabled,
        modelLabel: "免费生图模型",
        counts: [...GENERATION_POLICY.counts],
        sizes: [...GENERATION_POLICY.sizes],
        qualities: [...GENERATION_POLICY.qualities],
        maxPromptLength: GENERATION_POLICY.maxPromptLength,
        maxReferenceImages: GENERATION_POLICY.maxReferenceImages,
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
