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
    disabledReason?: string;
    modelLabel: string;
    maxPromptLength: number;
    maxReferenceImages: number;
  };
};

export type MiniappSessionResponse = Omit<PublicSessionResponse, "mode"> & {
  mode: "miniapp";
  token: string;
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
        ...(!config.publicGenerationEnabled ? { disabledReason: "免费生图当前由服务端暂停，请稍后重试。" } : {}),
        modelLabel: "免费生图模型",
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

  app.post("/api/miniapp/session", async (context) => {
    const config = context.get("config");
    const token = context.get("miniappToken") ?? context.req.header("X-Miniapp-Token");
    if (!token) {
      return context.json({ error: { code: "INVALID_REQUEST", message: "缺少小程序会话凭证" } }, 401);
    }
    const quota = await currentQuota(
      context.get("clientId"),
      context.get("quotaDate"),
      context.get("resetAt"),
      config.dailyDeviceLimit,
    );
    const response: MiniappSessionResponse = {
      mode: "miniapp",
      token,
      quota,
      generation: {
        enabled: config.publicGenerationEnabled,
        ...(!config.publicGenerationEnabled ? { disabledReason: "免费生图当前由服务端暂停，请稍后重试。" } : {}),
        modelLabel: "免费生图模型",
        maxPromptLength: GENERATION_POLICY.maxPromptLength,
        maxReferenceImages: GENERATION_POLICY.maxReferenceImages,
      },
    };
    return context.json(response);
  });
}
