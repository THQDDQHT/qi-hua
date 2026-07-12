import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import type { ServerConfig } from "../src/config";
import { createSql } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";
import { getShanghaiQuotaWindow } from "../src/routes/session";
import { createAnonymousToken, hashAnonymousToken } from "../src/security/anonymous-token";
import { hashDailyIp } from "../src/security/client-ip";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const sql = createSql(databaseUrl);
const config: ServerConfig = {
  port: 3001,
  databaseUrl,
  aiBaseUrl: "https://provider.example.com",
  aiApiKey: "provider-secret",
  aiModel: "private-model-name",
  anonTokenSecret: "anonymous-test-secret".padEnd(32, "a"),
  ipHashSecret: "ip-hash-test-secret".padEnd(32, "b"),
  publicOrigin: "https://canvas.example.com",
  publicGenerationEnabled: true,
  dailyDeviceLimit: 10,
  dailyIpLimit: 30,
  timezone: "Asia/Shanghai",
  upstreamTimeoutMs: 180000,
  reservationTtlSeconds: 600,
};
const app = createApp({ config, sql });
const trackedTokens = new Set<string>();

function request(path = "/api/session", headers: Record<string, string> = {}, method = "GET") {
  return app.request(path, {
    method,
    headers: { "CF-Connecting-IP": "203.0.113.9", ...headers },
  });
}

function readSessionToken(response: Response) {
  const setCookie = response.headers.get("set-cookie");
  const token = setCookie?.match(/(?:^|;\s*)anon_session=([^;]+)/)?.[1];
  if (!token) throw new Error("anon_session cookie is missing");
  trackedTokens.add(token);
  return token;
}

function trackIssuedToken(response: Response) {
  const token = response.headers.get("set-cookie")?.match(/anon_session=([^;]+)/)?.[1];
  if (token) trackedTokens.add(token);
}

async function findClientId(token: string) {
  const tokenHash = await hashAnonymousToken(token, config.anonTokenSecret);
  const [client] = await sql<{ id: string }[]>`
    select id from anonymous_clients where token_hash = ${tokenHash}
  `;
  if (!client) throw new Error("anonymous client is missing");
  return client.id;
}

async function countClients(token?: string) {
  const tokenHash = token && (await hashAnonymousToken(token, config.anonTokenSecret));
  const [{ count }] = tokenHash
    ? await sql<{ count: number }[]>`
        select count(*)::int as count from anonymous_clients where token_hash = ${tokenHash}
      `
    : await sql<{ count: number }[]>`select count(*)::int as count from anonymous_clients`;
  return count;
}

async function cleanupTestClients() {
  const hashes = await Promise.all(
    [...trackedTokens].map((token) => hashAnonymousToken(token, config.anonTokenSecret)),
  );
  if (hashes.length === 0) return;
  const clients = await sql<{ id: string }[]>`
    select id from anonymous_clients where token_hash in ${sql(hashes)}
  `;
  const clientIds = clients.map(({ id }) => id);
  if (clientIds.length === 0) return;
  await sql`delete from generation_requests where client_id in ${sql(clientIds)}`;
  await sql`delete from daily_client_quotas where client_id in ${sql(clientIds)}`;
  await sql`delete from anonymous_clients where id in ${sql(clientIds)}`;
}

beforeAll(async () => {
  const [{ databaseName }] = await sql<{ databaseName: string }[]>`
    select current_database() as "databaseName"
  `;
  if (databaseName !== "infinite_canvas_test") {
    throw new Error(`anonymous session tests require infinite_canvas_test, received ${databaseName}`);
  }
  await runMigrations(sql, resolve(import.meta.dir, "../migrations"));
});

afterAll(async () => {
  await cleanupTestClients();
  await sql.end();
});

describe("anonymous token security", () => {
  test("创建 32 字节 base64url 随机令牌", () => {
    const first = createAnonymousToken();
    const second = createAnonymousToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  test("匿名令牌使用令牌与密钥拼接后的 SHA-256 摘要", async () => {
    const digest = await hashAnonymousToken("test-token", "test-secret");
    expect(Buffer.from(digest).toString("hex")).toBe(
      "6ddfd24b4f17958b9d744c6d703a787392f363d8f9d19d535f0d10abe2b427ff",
    );
  });

  test("地址摘要按日期隔离并规范化 IPv6", async () => {
    const expanded = await hashDailyIp(
      "2001:0DB8:0000:0000:0000:0000:0000:0001",
      "2026-07-12",
      "test-secret",
    );
    const compressed = await hashDailyIp("2001:db8::1", "2026-07-12", "test-secret");
    const nextDay = await hashDailyIp("2001:db8::1", "2026-07-13", "test-secret");

    expect(expanded).toEqual(compressed);
    expect(nextDay).not.toEqual(compressed);
  });
});

describe("public anonymous session", () => {
  test("首次请求签发安全 Cookie 并返回固定公众能力", async () => {
    const response = await request();
    const body = await response.json();
    const setCookie = response.headers.get("set-cookie") ?? "";
    const token = readSessionToken(response);

    expect(response.status).toBe(200);
    expect(setCookie).toContain("anon_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=31536000");
    expect(setCookie).toContain("Path=/");
    expect(body).toEqual({
      mode: "public",
      quota: {
        limit: 10,
        used: 0,
        reserved: 0,
        remaining: 10,
        resetAt: expect.stringMatching(/T16:00:00\.000Z$/),
      },
      generation: {
        modelLabel: "免费生图模型",
        counts: [1, 2, 3, 4],
        sizes: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"],
        qualities: ["auto", "high", "medium", "low"],
        maxPromptLength: 4000,
        maxReferenceImages: 4,
      },
    });
    expect(JSON.stringify(body)).not.toContain(config.aiModel);
    expect(await findClientId(token)).toBeString();
  });

  test("重复请求复用同一客户端且不重新签发 Cookie", async () => {
    const first = await request();
    const token = readSessionToken(first);
    const clientId = await findClientId(token);
    const second = await request("/api/session", { Cookie: `anon_session=${token}` });

    expect(second.status).toBe(200);
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(await findClientId(token)).toBe(clientId);
  });

  test("未知令牌按原摘要注册并保留", async () => {
    const unknownToken = createAnonymousToken();
    trackedTokens.add(unknownToken);
    const response = await request("/api/session", { Cookie: `anon_session=${unknownToken}` });
    trackIssuedToken(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await findClientId(unknownToken)).toBeString();
  });

  test("相同未知令牌的并发会话请求收敛为一个客户端", async () => {
    const unknownToken = createAnonymousToken();
    trackedTokens.add(unknownToken);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request("/api/session", { Cookie: `anon_session=${unknownToken}` }),
      ),
    );
    responses.forEach(trackIssuedToken);

    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
    expect(responses.every((response) => response.headers.get("set-cookie") === null)).toBe(true);
    expect(await countClients(unknownToken)).toBe(1);
  });

  test("额度接口缺少 Cookie 时返回 401 且不创建客户端", async () => {
    const clientCount = await countClients();
    const response = await request("/api/quota");

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "请先建立匿名会话" },
    });
    expect(await countClients()).toBe(clientCount);
  });

  test("POST 会话接口缺少 Cookie 时返回 401 且不创建客户端", async () => {
    const clientCount = await countClients();
    const response = await request(
      "/api/session",
      { Origin: config.publicOrigin },
      "POST",
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "请先建立匿名会话" },
    });
    expect(await countClients()).toBe(clientCount);
  });

  test("非法 Cookie 返回 403 且不创建客户端", async () => {
    const clientCount = await countClients();
    const response = await request("/api/session", { Cookie: "anon_session=invalid" });

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "匿名会话凭证无效" },
    });
    expect(await countClients()).toBe(clientCount);
  });

  test("禁用客户端返回 403 且不换发 Cookie", async () => {
    const first = await request();
    const token = readSessionToken(first);
    const clientId = await findClientId(token);
    await sql`update anonymous_clients set status = 'disabled', disabled_at = now() where id = ${clientId}`;

    const response = await request("/api/session", { Cookie: `anon_session=${token}` });

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "此匿名客户端已被禁用" },
    });
  });

  test("非站点 Origin 的写请求返回 403", async () => {
    const response = await request(
      "/api/session",
      { Origin: "https://attacker.example.com" },
      "POST",
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "请求来源不受信任" },
    });
  });

  test("缺少 Cloudflare 地址标记时忽略伪造的转发地址", async () => {
    const response = await app.request("/api/session", {
      headers: { "X-Forwarded-For": "203.0.113.9" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "缺少可信的客户端地址" },
    });
  });

  test("额度接口读取当日设备成功数与预占数", async () => {
    const first = await request();
    const token = readSessionToken(first);
    const clientId = await findClientId(token);
    const { quotaDate } = getShanghaiQuotaWindow(new Date());
    await sql`
      insert into daily_client_quotas (client_id, quota_date, success_count, reserved_count)
      values (${clientId}, ${quotaDate}, 3, 2)
    `;

    const response = await request("/api/quota", { Cookie: `anon_session=${token}` });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      limit: 10,
      used: 3,
      reserved: 2,
      remaining: 5,
      resetAt: expect.stringMatching(/T16:00:00\.000Z$/),
    });
  });

  test("公众生图关闭时会话接口仍可用", async () => {
    const disabledApp = createApp({ sql, config: { ...config, publicGenerationEnabled: false } });
    const response = await disabledApp.request("/api/session", {
      headers: { "CF-Connecting-IP": "203.0.113.10" },
    });
    readSessionToken(response);

    expect(response.status).toBe(200);
  });
});

describe("Shanghai quota window", () => {
  test("北京时间零点切换额度日期与下次重置时间", () => {
    expect(getShanghaiQuotaWindow(new Date("2026-07-12T15:59:59.999Z"))).toEqual({
      quotaDate: "2026-07-12",
      resetAt: "2026-07-12T16:00:00.000Z",
    });
    expect(getShanghaiQuotaWindow(new Date("2026-07-12T16:00:00.000Z"))).toEqual({
      quotaDate: "2026-07-13",
      resetAt: "2026-07-13T16:00:00.000Z",
    });
  });
});
