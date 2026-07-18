import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import sharp from "sharp";
import type { AppEnv } from "../src/app";
import type { ServerConfig } from "../src/config";
import { PublicGenerationError } from "../src/domain/public-generation";
import { registerImageRoutes } from "../src/routes/images";

const config: ServerConfig = {
  port: 3001,
  databaseUrl: "postgres://unused",
  redisUrl: "redis://localhost:6379",
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
  reservationTtlSeconds: 21600,
  executionLeaseSeconds: 300,
  imageWorkerConcurrency: 5,
  generationStorageDir: "/tmp/infinite-canvas-test",
  generationResultTtlSeconds: 86400,
  workerHealthPort: 3002,
};

const taskId = "00000000-0000-4000-8000-000000000001";

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

function createRouteApp(overrides: Record<string, unknown> = {}) {
  const submissions: unknown[] = [];
  const service = {
    submit: async (input: unknown) => {
      submissions.push(input);
      return { taskId, status: "queued", replayed: false, expiresAt: "2040-01-02T03:00:00.000Z" };
    },
    getTask: async () => ({ taskId, status: "running", expiresAt: "2040-01-02T03:00:00.000Z" }),
    getResult: async () => ({ file: new Blob(["image"]), mimeType: "image/png" }),
    dispatchPending: async () => ({ candidates: 0, dispatched: 0 }),
    cleanupExpiredArtifacts: async () => ({ candidates: 0, deleted: 0 }),
    ...overrides,
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("config", {
      ...config,
      publicGenerationEnabled: typeof overrides.enabled === "boolean"
        ? overrides.enabled : config.publicGenerationEnabled,
    });
    context.set("clientId", "client-id");
    context.set("ipHash", new Uint8Array(32).fill(7));
    context.set("quotaDate", "2040-01-02");
    context.set("resetAt", "2040-01-02T16:00:00.000Z");
    await next();
  });
  registerImageRoutes(app, service as never);
  return { app, submissions };
}

describe("异步图片路由", () => {
  test("公众生图关闭时在解析请求前返回", async () => {
    const { app, submissions } = createRouteApp({ enabled: false });
    const response = await app.request("/api/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(response.status).toBe(503);
    expect(submissions).toHaveLength(0);
  });

  test("文生图立即返回任务编号、Location 和轮询间隔", async () => {
    const { app, submissions } = createRouteApp();
    const response = await app.request("/api/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(generationBody()),
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/api/images/tasks/${taskId}`);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.json()).toEqual({
      taskId,
      status: "queued",
      replayed: false,
      expiresAt: "2040-01-02T03:00:00.000Z",
    });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ operation: "generation", references: [] });
  });

  test("编辑请求校验并提交真实参考图", async () => {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    }).png().toBuffer();
    const form = new FormData();
    Object.entries(generationBody()).forEach(([key, value]) => form.set(key, String(value)));
    form.append("references", new File([bytes], "reference.png", { type: "text/plain" }));
    const { app, submissions } = createRouteApp();

    const response = await app.request("/api/images/edits", { method: "POST", body: form });

    expect(response.status).toBe(202);
    expect(submissions[0]).toMatchObject({ operation: "edit" });
    expect((submissions[0] as { references: unknown[] }).references).toHaveLength(1);
  });

  test.each([
    ["not-json", "application/json"],
    [JSON.stringify(generationBody({ count: 5 })), "application/json"],
    [JSON.stringify(generationBody({ prompt: "   " })), "application/json"],
  ])("非法文生图请求不创建任务", async (body, contentType) => {
    const { app, submissions } = createRouteApp();
    const response = await app.request("/api/images/generations", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
    expect(response.status).toBe(400);
    expect(submissions).toHaveLength(0);
  });

  test("超大 multipart 在解析前返回 413", async () => {
    const { app, submissions } = createRouteApp();
    const response = await app.request("/api/images/edits", {
      method: "POST",
      headers: { "Content-Length": String(23 * 1024 * 1024) },
      body: "ignored",
    });
    expect(response.status).toBe(413);
    expect(submissions).toHaveLength(0);
  });

  test("伪装参考图返回 INVALID_IMAGE", async () => {
    const form = new FormData();
    Object.entries(generationBody()).forEach(([key, value]) => form.set(key, String(value)));
    form.append("references", new File(["not-image"], "fake.png", { type: "image/png" }));
    const { app, submissions } = createRouteApp();
    const response = await app.request("/api/images/edits", { method: "POST", body: form });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_IMAGE" } });
    expect(submissions).toHaveLength(0);
  });

  test("任务状态查询传递客户端所有权上下文", async () => {
    const calls: unknown[] = [];
    const { app } = createRouteApp({
      getTask: async (input: unknown) => {
        calls.push(input);
        return { taskId, status: "running", expiresAt: "2040-01-02T03:00:00.000Z" };
      },
    });

    const response = await app.request(`/api/images/tasks/${taskId}`);

    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      requestId: taskId,
      clientId: "client-id",
      quotaDate: "2040-01-02",
      resetAt: "2040-01-02T16:00:00.000Z",
    }]);
  });

  test("结果文件按原类型返回且不公开缓存", async () => {
    const { app } = createRouteApp();
    const response = await app.request(`/api/images/tasks/${taskId}/results/0`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("image");
  });

  test.each([
    ["TASK_NOT_FOUND", 404],
    ["RESULT_EXPIRED", 410],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["QUOTA_EXHAUSTED", 429],
  ] as const)("将 %s 映射为 HTTP %s", async (code, status) => {
    const { app } = createRouteApp({
      getTask: async () => { throw new PublicGenerationError(code); },
    });
    const response = await app.request(`/api/images/tasks/${taskId}`);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  test("未知异常不泄漏内部内容", async () => {
    const { app } = createRouteApp({
      submit: async () => { throw new Error("private provider body"); },
    });
    const response = await app.request("/api/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(generationBody()),
    });
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).not.toContain("private provider body");
  });
});
