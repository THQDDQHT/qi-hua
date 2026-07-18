import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const valid = {
  DATABASE_URL: "postgres://test:test@localhost:55432/test",
  REDIS_URL: "redis://infinite_canvas:secret@redis_shared:6379/0",
  AI_BASE_URL: "https://provider.example.com",
  AI_API_KEY: "secret",
  AI_MODEL: "image-model",
  ANON_TOKEN_SECRET: "a".repeat(32),
  IP_HASH_SECRET: "b".repeat(32),
  IDEMPOTENCY_SECRET: "c".repeat(32),
  PUBLIC_ORIGIN: "https://canvas.example.com",
};

describe("loadConfig", () => {
  test("使用设计确认的默认额度", () => {
    const config = loadConfig(valid);
    expect(config.dailyDeviceLimit).toBe(10);
    expect(config.dailyIpLimit).toBe(30);
    expect(config.timezone).toBe("Asia/Shanghai");
    expect(config.publicGenerationEnabled).toBe(true);
    expect(config.imageWorkerConcurrency).toBe(5);
    expect(config.reservationTtlSeconds).toBe(21600);
    expect(config.executionLeaseSeconds).toBe(300);
    expect(config.generationResultTtlSeconds).toBe(86400);
    expect(config.workerHealthPort).toBe(3002);
  });

  test("缺少密钥时拒绝启动", () => {
    expect(() => loadConfig({ ...valid, AI_API_KEY: "" })).toThrow("AI_API_KEY");
    expect(() => loadConfig({ ...valid, IDEMPOTENCY_SECRET: "" })).toThrow("IDEMPOTENCY_SECRET");
    expect(() => loadConfig({ ...valid, IDEMPOTENCY_SECRET: "c".repeat(31) }))
      .toThrow("IDEMPOTENCY_SECRET");
  });

  test("日额度限制必须适配 smallint", () => {
    expect(loadConfig({
      ...valid,
      DAILY_DEVICE_LIMIT: "1",
      DAILY_IP_LIMIT: "32767",
    })).toMatchObject({ dailyDeviceLimit: 1, dailyIpLimit: 32767 });

    for (const value of ["0", "-1", "1.5", "invalid", "32768"]) {
      expect(() => loadConfig({ ...valid, DAILY_DEVICE_LIMIT: value })).toThrow("DAILY_DEVICE_LIMIT");
      expect(() => loadConfig({ ...valid, DAILY_IP_LIMIT: value })).toThrow("DAILY_IP_LIMIT");
    }
  });

  test("其他正整数配置不受 smallint 上限影响", () => {
    expect(loadConfig({ ...valid, UPSTREAM_TIMEOUT_MS: "180000" }).upstreamTimeoutMs).toBe(180000);
  });

  test("异步任务配置拒绝非法值", () => {
    expect(() => loadConfig({ ...valid, REDIS_URL: "https://redis.example.com" })).toThrow("REDIS_URL");
    expect(() => loadConfig({ ...valid, IMAGE_WORKER_CONCURRENCY: "11" })).toThrow("IMAGE_WORKER_CONCURRENCY");
    expect(() => loadConfig({ ...valid, GENERATION_STORAGE_DIR: "relative" })).toThrow("GENERATION_STORAGE_DIR");
    expect(() => loadConfig({ ...valid, EXECUTION_LEASE_SECONDS: "180" })).toThrow("EXECUTION_LEASE_SECONDS");
  });
});
