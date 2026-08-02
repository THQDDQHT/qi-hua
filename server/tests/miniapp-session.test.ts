import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { ServerConfig } from "../src/config";
import { hashAnonymousToken } from "../src/security/anonymous-token";
import { createDatabaseTestHarness } from "./helpers/database";

const database = createDatabaseTestHarness({ migrate: true });
const { sql } = database;
const config: ServerConfig = {
  port: 3001,
  databaseUrl: process.env.TEST_DATABASE_URL!,
  redisUrl: "redis://localhost:6379",
  aiBaseUrl: "https://provider.example.com",
  aiApiKey: "provider-secret",
  aiModel: "private-model-name",
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
const app = createApp({ config, sql });
const trackedTokens = new Set<string>();

type MiniappSessionBody = {
  mode: string;
  token: string;
  quota: { limit: number; used: number; reserved: number; remaining: number; resetAt: string };
  generation: { enabled: boolean; maxPromptLength: number; maxReferenceImages: number };
};

function createMiniappSession(token?: string) {
  return app.request("/api/miniapp/session", {
    method: "POST",
    headers: token ? { "X-Miniapp-Token": token } : {},
  });
}

async function readSession(response: Response) {
  expect(response.status).toBe(200);
  const body = (await response.json()) as MiniappSessionBody;
  trackedTokens.add(body.token);
  return body;
}

async function countClients(token: string) {
  const tokenHash = await hashAnonymousToken(token, config.anonTokenSecret);
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from anonymous_clients where token_hash = ${tokenHash}
  `;
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

beforeAll(database.setup, { timeout: 120_000 });

afterAll(async () => {
  try {
    await cleanupTestClients();
  } finally {
    await database.teardown();
  }
}, { timeout: 120_000 });

describe("miniapp session", () => {
  test("无凭证创建会话并返回 token，不依赖 Origin 与 CF-Connecting-IP", async () => {
    const session = await readSession(await createMiniappSession());

    expect(session.mode).toBe("miniapp");
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.quota.limit).toBe(10);
    expect(session.generation.enabled).toBe(true);
    expect(await countClients(session.token)).toBe(1);
  });

  test("携带 token 重复创建复用同一客户端", async () => {
    const first = await readSession(await createMiniappSession());
    const second = await readSession(await createMiniappSession(first.token));

    expect(second.token).toBe(first.token);
    expect(await countClients(first.token)).toBe(1);
  });

  test("携带 token 可直接读取配额，无需 Origin 与 CF-Connecting-IP", async () => {
    const session = await readSession(await createMiniappSession());
    const response = await app.request("/api/quota", {
      headers: { "X-Miniapp-Token": session.token },
    });

    expect(response.status).toBe(200);
    const quota = (await response.json()) as { limit: number; remaining: number };
    expect(quota.limit).toBe(10);
  });

  test("格式非法的 token 返回 403", async () => {
    const response = await createMiniappSession("not-a-valid-token");
    expect(response.status).toBe(403);
  });

  test("无任何凭证访问配额返回 401", async () => {
    const response = await app.request("/api/quota", {
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    });
    expect(response.status).toBe(401);
  });
});
