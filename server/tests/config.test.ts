import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const valid = {
  DATABASE_URL: "postgres://test:test@localhost:55432/test",
  AI_BASE_URL: "https://provider.example.com",
  AI_API_KEY: "secret",
  AI_MODEL: "image-model",
  ANON_TOKEN_SECRET: "a".repeat(32),
  IP_HASH_SECRET: "b".repeat(32),
  PUBLIC_ORIGIN: "https://canvas.example.com",
};

describe("loadConfig", () => {
  test("使用设计确认的默认额度", () => {
    const config = loadConfig(valid);
    expect(config.dailyDeviceLimit).toBe(10);
    expect(config.dailyIpLimit).toBe(30);
    expect(config.timezone).toBe("Asia/Shanghai");
    expect(config.publicGenerationEnabled).toBe(true);
  });

  test("缺少密钥时拒绝启动", () => {
    expect(() => loadConfig({ ...valid, AI_API_KEY: "" })).toThrow("AI_API_KEY");
  });
});
