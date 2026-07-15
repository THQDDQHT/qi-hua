import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import sharp from "sharp";
import type { AppEnv } from "../src/app";
import type { ServerConfig } from "../src/config";
import { PublicGenerationError, type PublicGenerationErrorCode } from "../src/domain/public-generation";
import { registerImageRoutes } from "../src/routes/images";
import type { GenerationBatchResult, GenerationInProgressResult } from "../src/services/generation-service";

type GenerationService = Parameters<typeof registerImageRoutes>[1];
type ExecuteInput = Parameters<GenerationService["execute"]>[0];
type ExecuteResult = GenerationBatchResult | GenerationInProgressResult;

const quota = {
  limit: 10,
  used: 1,
  reserved: 0,
  remaining: 9,
  resetAt: "2026-07-14T16:00:00.000Z",
};

const config: ServerConfig = {
  port: 3001,
  databaseUrl: "postgres://unused",
  aiBaseUrl: "https://provider.example.com",
  aiApiKey: "provider-secret",
  aiModel: "private-model",
  anonTokenSecret: "anonymous-test-secret".padEnd(32, "a"),
  ipHashSecret: "ip-hash-test-secret".padEnd(32, "b"),
  idempotencySecret: "idempotency-test-secret".padEnd(32, "c"),
  publicOrigin: "https://canvas.example.com",
  publicGenerationEnabled: true,
  dailyDeviceLimit: 10,
  dailyIpLimit: 30,
  timezone: "Asia/Shanghai",
  upstreamTimeoutMs: 180000,
  reservationTtlSeconds: 600,
};

function completedResult(status: "completed" | "partial" | "failed" = "completed"): GenerationBatchResult {
  return {
    status,
    replayed: false,
    results: [{ index: 0, status: "success", image: { mimeType: "image/png", data: "image-data" } }],
    quota,
  };
}

function createRouteApp(input: {
  enabled?: boolean;
  execute?: (value: ExecuteInput) => Promise<ExecuteResult>;
} = {}) {
  const calls: ExecuteInput[] = [];
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("config", { ...config, publicGenerationEnabled: input.enabled ?? true });
    context.set("clientId", "client-id");
    context.set("ipHash", new Uint8Array(32).fill(7));
    context.set("quotaDate", "2026-07-14");
    context.set("resetAt", quota.resetAt);
    await next();
  });
  registerImageRoutes(app, {
    execute: async (value) => {
      calls.push(value);
      return input.execute ? input.execute(value) : completedResult();
    },
  });
  return { app, calls };
}

function generationBody(overrides: Record<string, unknown> = {}) {
  return {
    requestKey: "request-key",
    prompt: "一只猫",
    count: 1,
    size: "1:1",
    quality: "high",
    ...overrides,
  };
}

describe("图片路由", () => {
  test("公众生图关闭时在解析请求前返回且不调用服务", async () => {
    const { app, calls } = createRouteApp({ enabled: false });
    const response = await app.request("/api/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "PUBLIC_GENERATION_OFF", message: "公众生图暂时关闭" },
    });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["completed", 200],
    ["partial", 200],
    ["failed", 200],
  ] as const)("文生图 %s 批次返回 %s 并传递会话上下文", async (status, expectedStatus) => {
    const { app, calls } = createRouteApp({ execute: async () => completedResult(status) });
    const response = await app.request("/api/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(generationBody()),
    });

    expect(response.status).toBe(expectedStatus);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: "generation",
      generation: generationBody(),
      references: [],
      clientId: "client-id",
      quotaDate: "2026-07-14",
    });
    expect(calls[0].ipHash).toEqual(new Uint8Array(32).fill(7));
  });

  test("运行中重放返回 202", async () => {
    const { app } = createRouteApp({ execute: async () => ({ status: "running", replayed: true }) });
    const response = await app.request("/api/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(generationBody()),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "running", replayed: true });
  });

  test("自定义尺寸和四张批次可进入生成服务", async () => {
    const { app, calls } = createRouteApp();
    const response = await app.request("/api/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(generationBody({ count: 4, size: "1600x912", quality: "low" })),
    });

    expect(response.status).toBe(200);
    expect(calls[0]?.generation).toMatchObject({ count: 4, size: "1600x912", quality: "low" });
  });

  test.each([
    ["not-json", "application/json"],
    [JSON.stringify(generationBody({ prompt: "   " })), "application/json"],
    [JSON.stringify(generationBody({ count: 5 })), "application/json"],
    [JSON.stringify(generationBody({ size: "custom" })), "application/json"],
  ])("非法文生图请求不会调用服务", async (body, contentType) => {
    const { app, calls } = createRouteApp();
    const response = await app.request("/api/images/generations", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("multipart 非法 count 不调用服务", async () => {
    const form = new FormData();
    Object.entries(generationBody({ count: 5 })).forEach(([key, value]) => form.set(key, String(value)));
    const { app, calls } = createRouteApp();

    const response = await app.request("/api/images/edits", { method: "POST", body: form });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(calls).toHaveLength(0);
  });

  test("编辑请求校验真实图片并传给服务", async () => {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    }).png().toBuffer();
    const form = new FormData();
    Object.entries(generationBody()).forEach(([key, value]) => form.set(key, String(value)));
    form.append("references", new File([bytes], "reference.png", { type: "text/plain" }));
    const { app, calls } = createRouteApp();

    const response = await app.request("/api/images/edits", { method: "POST", body: form });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ operation: "edit", generation: generationBody() });
    expect(calls[0].references).toHaveLength(1);
    expect(calls[0].references[0]).toMatchObject({ mimeType: "image/png" });
  });

  test("超大编辑请求按 Content-Length 提前返回 413", async () => {
    const { app, calls } = createRouteApp();
    const response = await app.request("/api/images/edits", {
      method: "POST",
      headers: { "Content-Length": String(23 * 1024 * 1024) },
      body: "ignored",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_TOO_LARGE" } });
    expect(calls).toHaveLength(0);
  });

  test("伪装参考图返回 INVALID_IMAGE 且不调用服务", async () => {
    const form = new FormData();
    Object.entries(generationBody()).forEach(([key, value]) => form.set(key, String(value)));
    form.append("references", new File(["not-image"], "fake.png", { type: "image/png" }));
    const { app, calls } = createRouteApp();

    const response = await app.request("/api/images/edits", { method: "POST", body: form });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_IMAGE" } });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["IDEMPOTENCY_CONFLICT", 409],
    ["QUOTA_EXHAUSTED", 429],
    ["IP_QUOTA_EXHAUSTED", 429],
    ["PROVIDER_REJECTED", 502],
    ["SERVICE_UNAVAILABLE", 503],
    ["PROVIDER_TIMEOUT", 504],
  ] as const)("将 %s 映射为 HTTP %s", async (code, expectedStatus) => {
    const { app } = createRouteApp({
      execute: async () => { throw new PublicGenerationError(code as PublicGenerationErrorCode, "受控错误"); },
    });
    const response = await app.request("/api/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(generationBody()),
    });

    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual({ error: { code, message: "受控错误" } });
  });

  test("未知异常返回通用 503 且不泄漏内部内容", async () => {
    const { app } = createRouteApp({
      execute: async () => { throw new Error("private provider body temporary-image-marker"); },
    });
    const response = await app.request("/api/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(generationBody()),
    });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({ error: { code: "SERVICE_UNAVAILABLE", message: "SERVICE_UNAVAILABLE" } });
    expect(body).not.toContain("private provider body");
    expect(body).not.toContain("temporary-image-marker");
  });
});
