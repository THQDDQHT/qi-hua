import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createQuotaRepository } from "../src/db/quota-repository";
import { createQuotaService, QuotaServiceError } from "../src/services/quota-service";
import { createDatabaseTestHarness } from "./helpers/database";

const database = createDatabaseTestHarness({ migrate: true });
const { sql } = database;
const repository = createQuotaRepository(sql);
const service = createQuotaService({ repository, deviceLimit: 10, ipLimit: 30 });
const quotaDate = "2040-01-02";
const expiresAt = new Date("2040-01-02T01:10:00Z");
const settlementNow = new Date("2040-01-02T01:05:00Z");

function id(index: number) {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function ipHash(value: number) {
  return new Uint8Array([value]);
}

function fingerprint(value = 1) {
  return new Uint8Array(32).fill(value);
}

function reserveInput(overrides: Partial<Parameters<typeof service.reserveQuota>[0]> = {}) {
  return {
    clientId: id(10),
    requestKey: crypto.randomUUID(),
    payloadFingerprint: fingerprint(10),
    ipHash: ipHash(10),
    quotaDate,
    requestedCount: 4,
    expiresAt,
    ...overrides,
  };
}

async function readCounts(clientId: string, hash: Uint8Array, date = quotaDate) {
  const [client] = await sql<{ successCount: number; reservedCount: number }[]>`
    select success_count as "successCount", reserved_count as "reservedCount"
    from daily_client_quotas where client_id = ${clientId} and quota_date = ${date}
  `;
  const [ip] = await sql<{ successCount: number; reservedCount: number }[]>`
    select success_count as "successCount", reserved_count as "reservedCount"
    from daily_ip_quotas where ip_hash = ${hash} and quota_date = ${date}
  `;
  return { client, ip };
}

async function readRequest(requestId: string) {
  const [request] = await sql<{
    status: string;
    requestedCount: number;
    reservedCount: number;
    successCount: number;
    errorCode: string | null;
    completedAt: Date | null;
  }[]>`
    select status, requested_count as "requestedCount", reserved_count as "reservedCount",
      success_count as "successCount", error_code as "errorCode", completed_at as "completedAt"
    from generation_requests where id = ${requestId}
  `;
  return request;
}

async function reserveAndClaim(
  overrides: Partial<Parameters<typeof service.reserveQuota>[0]> = {},
  now = settlementNow,
) {
  const input = reserveInput(overrides);
  const reservation = await service.reserveQuota(input);
  const claim = await service.claimForExecution({ requestId: reservation.requestId, now });
  expect(claim).toEqual({
    kind: "claimed",
    requestId: reservation.requestId,
    status: "running",
  });
  return { input, reservation };
}

beforeAll(database.setup, { timeout: 120_000 });
afterEach(async () => {
  await sql`delete from generation_requests`;
  await sql`delete from daily_client_quotas`;
  await sql`delete from daily_ip_quotas`;
});
afterAll(database.teardown, { timeout: 120_000 });

describe("quota reservation", () => {
  test("同一设备并发十二次恰好预占十次", async () => {
    const clientId = id(1);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => service.reserveQuota({
        clientId,
        requestKey: `device-request-${index}`,
        payloadFingerprint: fingerprint(index),
        ipHash: ipHash(1),
        quotaDate,
        requestedCount: 1,
        expiresAt,
      })),
    );

    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(10);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(2);
    for (const item of results.filter((item) => item.status === "rejected")) {
      expect(item.reason).toBeInstanceOf(QuotaServiceError);
      expect(item.reason).toMatchObject({ code: "QUOTA_EXHAUSTED" });
    }
    const [quota] = await sql<{ successCount: number; reservedCount: number }[]>`
      select success_count as "successCount", reserved_count as "reservedCount"
      from daily_client_quotas where client_id = ${clientId} and quota_date = ${quotaDate}
    `;
    expect(quota).toEqual({ successCount: 0, reservedCount: 10 });
  });

  test("同一地址不同设备并发三十五次恰好预占三十次", async () => {
    const sharedIpHash = ipHash(2);
    const results = await Promise.allSettled(
      Array.from({ length: 35 }, (_, index) => service.reserveQuota({
        clientId: id(index + 100),
        requestKey: `ip-request-${index}`,
        payloadFingerprint: fingerprint(index),
        ipHash: sharedIpHash,
        quotaDate,
        requestedCount: 1,
        expiresAt,
      })),
    );

    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(30);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(5);
    for (const item of results.filter((item) => item.status === "rejected")) {
      expect(item.reason).toMatchObject({ code: "IP_QUOTA_EXHAUSTED" });
    }
    const [quota] = await sql<{ successCount: number; reservedCount: number }[]>`
      select success_count as "successCount", reserved_count as "reservedCount"
      from daily_ip_quotas where ip_hash = ${sharedIpHash} and quota_date = ${quotaDate}
    `;
    expect(quota).toEqual({ successCount: 0, reservedCount: 30 });
  });

  test("相同请求键、指纹和数量并发时只预占一次", async () => {
    const input = reserveInput({
      clientId: id(2),
      requestKey: "duplicate-request",
      payloadFingerprint: fingerprint(2),
      ipHash: ipHash(3),
      requestedCount: 1,
    });
    const reservations = await Promise.all([
      service.reserveQuota(input),
      service.reserveQuota({
        ...input,
        ipHash: ipHash(99),
        quotaDate: "2040-01-03",
        expiresAt: new Date("2040-01-03T01:10:00Z"),
      }),
    ]);

    expect(reservations.map(({ kind }) => kind).sort()).toEqual(["replay", "reserved"]);
    expect(new Set(reservations.map(({ requestId }) => requestId))).toHaveLength(1);
    const [{ requestCount, reservedCount }] = await sql<{
      requestCount: number;
      reservedCount: number;
    }[]>`
      select count(*)::int as "requestCount", sum(reserved_count)::int as "reservedCount"
      from generation_requests where client_id = ${input.clientId} and request_key = ${input.requestKey}
    `;
    expect({ requestCount, reservedCount }).toEqual({ requestCount: 1, reservedCount: 1 });
  });

  test("相同请求键但指纹或数量不同返回幂等冲突", async () => {
    const input = reserveInput({ requestedCount: 1, payloadFingerprint: fingerprint(3) });
    const first = await service.reserveQuota(input);

    await expect(service.reserveQuota({ ...input, payloadFingerprint: fingerprint(4) }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(service.reserveQuota({ ...input, requestedCount: 2 }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    expect(await readRequest(first.requestId)).toMatchObject({
      status: "reserved",
      requestedCount: 1,
      reservedCount: 1,
      successCount: 0,
    });
    expect(await readCounts(input.clientId, input.ipHash)).toEqual({
      client: { successCount: 0, reservedCount: 1 },
      ip: { successCount: 0, reservedCount: 1 },
    });
  });

  test("非法数量和指纹不产生请求或额度行", async () => {
    for (const requestedCount of [0, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(service.reserveQuota(reserveInput({ requestedCount })))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    for (const payloadFingerprint of [new Uint8Array(31), new Uint8Array(33)]) {
      await expect(service.reserveQuota(reserveInput({ payloadFingerprint })))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }

    const [{ requests }] = await sql<{ requests: number }[]>`
      select count(*)::int as requests from generation_requests
    `;
    const [{ quotas }] = await sql<{ quotas: number }[]>`
      select (
        (select count(*) from daily_client_quotas)
        + (select count(*) from daily_ip_quotas)
      )::int as quotas
    `;
    expect({ requests, quotas }).toEqual({ requests: 0, quotas: 0 });
  });

  test("额度不足时不遗留请求行或额外预占", async () => {
    const clientId = id(4);
    for (let index = 0; index < 10; index++) {
      await service.reserveQuota(reserveInput({
        clientId,
        requestKey: `fill-${index}`,
        payloadFingerprint: fingerprint(index),
        ipHash: ipHash(4),
        requestedCount: 1,
      }));
    }
    await expect(service.reserveQuota(reserveInput({
      clientId,
      requestKey: "overflow",
      payloadFingerprint: fingerprint(31),
      ipHash: ipHash(4),
      requestedCount: 1,
    }))).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });

    const [{ requestCount }] = await sql<{ requestCount: number }[]>`
      select count(*)::int as "requestCount" from generation_requests where client_id = ${clientId}
    `;
    expect(requestCount).toBe(10);
    expect((await readCounts(clientId, ipHash(4))).client?.reservedCount).toBe(10);
  });
});

describe("quota claim", () => {
  test("两个并发领取者只有一个获得执行权", async () => {
    const reservation = await service.reserveQuota(reserveInput({ requestedCount: 1 }));
    const results = await Promise.all([
      service.claimForExecution({ requestId: reservation.requestId, now: settlementNow }),
      service.claimForExecution({ requestId: reservation.requestId, now: settlementNow }),
    ]);

    expect(results.map(({ kind }) => kind).sort()).toEqual(["claimed", "not-claimed"]);
    expect(results.find(({ kind }) => kind === "not-claimed")).toMatchObject({ status: "running" });
    expect(await readRequest(reservation.requestId)).toMatchObject({ status: "running" });
  });

  test("运行中请求再次领取返回 not-claimed", async () => {
    const { reservation } = await reserveAndClaim({ requestedCount: 1 });
    await expect(service.claimForExecution({ requestId: reservation.requestId, now: settlementNow }))
      .resolves.toEqual({
        kind: "not-claimed",
        requestId: reservation.requestId,
        status: "running",
      });
  });

  test("领取已到期 reserved 会释放预占并转为 expired", async () => {
    const input = reserveInput({
      requestedCount: 2,
      expiresAt: new Date("2040-01-02T01:00:00Z"),
    });
    const reservation = await service.reserveQuota(input);

    const result = await service.claimForExecution({
      requestId: reservation.requestId,
      now: new Date("2040-01-02T01:00:01Z"),
    });

    expect(result).toEqual({
      kind: "not-claimed",
      requestId: reservation.requestId,
      status: "expired",
    });
    expect(await readCounts(input.clientId, input.ipHash)).toEqual({
      client: { successCount: 0, reservedCount: 0 },
      ip: { successCount: 0, reservedCount: 0 },
    });
    expect(await readRequest(reservation.requestId)).toMatchObject({
      status: "expired",
      reservedCount: 0,
      successCount: 0,
    });
  });

  test("已到期 running 由回收器处理而不是 claim 改写", async () => {
    const { reservation } = await reserveAndClaim({
      requestedCount: 1,
      expiresAt: new Date("2040-01-02T01:06:00Z"),
    });

    await expect(service.claimForExecution({
      requestId: reservation.requestId,
      now: new Date("2040-01-02T01:06:01Z"),
    })).resolves.toMatchObject({ kind: "not-claimed", status: "running" });
  });
});

describe("quota settlement", () => {
  test("全部成功、部分成功和全部失败按实际数量结算", async () => {
    const cases = [
      { successCount: 4, status: "completed", errorCode: undefined },
      { successCount: 2, status: "partial", errorCode: "PROVIDER_REJECTED" as const },
      { successCount: 0, status: "failed", errorCode: "PROVIDER_TIMEOUT" as const },
    ];

    for (const [index, item] of cases.entries()) {
      const { input, reservation } = await reserveAndClaim({
        clientId: id(20 + index),
        ipHash: ipHash(20 + index),
      });
      const result = await service.settleQuota({
        requestId: reservation.requestId,
        successCount: item.successCount,
        errorCode: item.errorCode,
        now: settlementNow,
      });

      expect(result).toMatchObject({
        kind: "settled",
        status: item.status,
        quota: {
          limit: 10,
          used: item.successCount,
          reserved: 0,
          remaining: 10 - item.successCount,
          resetAt: "2040-01-02T16:00:00.000Z",
        },
      });
      expect(await readCounts(input.clientId, input.ipHash)).toEqual({
        client: { successCount: item.successCount, reservedCount: 0 },
        ip: { successCount: item.successCount, reservedCount: 0 },
      });
      expect(await readRequest(reservation.requestId)).toMatchObject({
        status: item.status,
        reservedCount: 0,
        successCount: item.successCount,
        errorCode: item.status === "completed" ? null : item.errorCode,
      });
    }
  });

  test("未领取的 reserved 请求不能结算", async () => {
    const input = reserveInput();
    const reservation = await service.reserveQuota(input);

    await expect(service.settleQuota({
      requestId: reservation.requestId,
      successCount: 4,
      now: settlementNow,
    })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });

    expect(await readRequest(reservation.requestId)).toMatchObject({
      status: "reserved",
      reservedCount: 4,
      successCount: 0,
    });
  });

  test("非法成功数和活跃请求未知错误码完整回滚", async () => {
    const { input, reservation } = await reserveAndClaim();

    for (const successCount of [-1, 1.5, 5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(service.settleQuota({
        requestId: reservation.requestId,
        successCount,
        now: settlementNow,
      })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    await expect(service.settleQuota({
      requestId: reservation.requestId,
      successCount: 0,
      errorCode: "raw provider details" as never,
      now: settlementNow,
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    expect(await readRequest(reservation.requestId)).toMatchObject({
      status: "running",
      reservedCount: 4,
      successCount: 0,
      errorCode: null,
    });
    expect(await readCounts(input.clientId, input.ipHash)).toEqual({
      client: { successCount: 0, reservedCount: 4 },
      ip: { successCount: 0, reservedCount: 4 },
    });
  });

  test("终态重复结算忽略新参数且不重复计数", async () => {
    const { input, reservation } = await reserveAndClaim();
    const first = await service.settleQuota({
      requestId: reservation.requestId,
      successCount: 2,
      errorCode: "PROVIDER_REJECTED",
      now: settlementNow,
    });
    const second = await service.settleQuota({
      requestId: reservation.requestId,
      successCount: 99,
      errorCode: "raw provider details" as never,
      now: new Date("2040-01-02T01:06:00Z"),
    });

    expect(first).toMatchObject({ kind: "settled", status: "partial" });
    expect(second).toMatchObject({ kind: "already-settled", status: "partial" });
    expect(await readCounts(input.clientId, input.ipHash)).toEqual({
      client: { successCount: 2, reservedCount: 0 },
      ip: { successCount: 2, reservedCount: 0 },
    });
  });

  test("过期请求的迟到结算返回 expired 且不增加成功数", async () => {
    const input = reserveInput({ expiresAt: new Date("2040-01-02T01:00:00Z") });
    const reservation = await service.reserveQuota(input);
    await service.expireReservations(new Date("2040-01-02T01:00:01Z"));

    const result = await service.settleQuota({
      requestId: reservation.requestId,
      successCount: 4,
      errorCode: "raw provider details" as never,
      now: new Date("2040-01-02T01:00:02Z"),
    });

    expect(result).toMatchObject({ kind: "expired", status: "expired" });
    expect(await readCounts(input.clientId, input.ipHash)).toEqual({
      client: { successCount: 0, reservedCount: 0 },
      ip: { successCount: 0, reservedCount: 0 },
    });
  });

  test("跨北京时间零点只修改旧日账务并返回当前日额度", async () => {
    const oldDate = "2040-01-02";
    const currentDate = "2040-01-03";
    const input = reserveInput({
      quotaDate: oldDate,
      expiresAt: new Date("2040-01-03T01:00:00Z"),
    });
    const reservation = await service.reserveQuota(input);
    await service.claimForExecution({
      requestId: reservation.requestId,
      now: new Date("2040-01-02T15:59:59Z"),
    });
    await sql`
      insert into daily_client_quotas (client_id, quota_date, success_count, reserved_count)
      values (${input.clientId}, ${currentDate}, 3, 1)
    `;

    const result = await service.settleQuota({
      requestId: reservation.requestId,
      successCount: 2,
      errorCode: "PROVIDER_REJECTED",
      now: new Date("2040-01-02T16:00:01Z"),
    });

    expect(result).toEqual({
      kind: "settled",
      status: "partial",
      quota: {
        limit: 10,
        used: 3,
        reserved: 1,
        remaining: 6,
        resetAt: "2040-01-03T16:00:00.000Z",
      },
    });
    expect(await readCounts(input.clientId, input.ipHash, oldDate)).toEqual({
      client: { successCount: 2, reservedCount: 0 },
      ip: { successCount: 2, reservedCount: 0 },
    });
  });
});

describe("quota expiration", () => {
  test("并发回收同一过期请求只释放一次", async () => {
    const input = reserveInput({ expiresAt: new Date("2040-01-02T01:00:00Z") });
    const reservation = await service.reserveQuota(input);

    const results = await Promise.all([
      service.expireReservations(new Date("2040-01-02T01:00:01Z")),
      service.expireReservations(new Date("2040-01-02T01:00:01Z")),
    ]);

    expect(results.reduce((total, result) => total + result.expired, 0)).toBe(1);
    expect(results.reduce((total, result) => total + result.skipped, 0)).toBe(1);
    expect(await readRequest(reservation.requestId)).toMatchObject({
      status: "expired",
      reservedCount: 0,
    });
  });

  test("最老坏行不阻塞后续健康请求", async () => {
    const firstInput = reserveInput({
      clientId: id(40),
      ipHash: ipHash(40),
      expiresAt: new Date("2040-01-02T01:00:00Z"),
    });
    const secondInput = reserveInput({
      clientId: id(41),
      ipHash: ipHash(41),
      expiresAt: new Date("2040-01-02T01:00:01Z"),
    });
    const first = await service.reserveQuota(firstInput);
    const second = await service.reserveQuota(secondInput);
    await sql`
      update daily_client_quotas set reserved_count = 3
      where client_id = ${firstInput.clientId} and quota_date = ${firstInput.quotaDate}
    `;

    const logs: unknown[][] = [];
    const isolatedService = createQuotaService({
      repository,
      deviceLimit: 10,
      ipLimit: 30,
      logger: { error: (...args: unknown[]) => logs.push(args) },
    });
    const result = await isolatedService.expireReservations(new Date("2040-01-02T01:00:02Z"));

    expect(result).toEqual({ expired: 1, skipped: 0, inconsistent: 1 });
    expect(logs).toEqual([[
      "Quota reservation consistency error",
      { requestId: first.requestId, stage: "expire" },
    ]]);
    expect(await readRequest(first.requestId)).toMatchObject({ status: "reserved", reservedCount: 4 });
    expect(await readRequest(second.requestId)).toMatchObject({ status: "expired", reservedCount: 0 });
  });

  test("结算和过期并发只产生一个不可逆终态", async () => {
    const { reservation } = await reserveAndClaim({
      expiresAt: new Date("2040-01-02T01:05:00Z"),
    }, new Date("2040-01-02T01:04:59Z"));
    const now = new Date("2040-01-02T01:05:01Z");

    const results = await Promise.all([
      service.settleQuota({ requestId: reservation.requestId, successCount: 4, now }),
      service.expireReservations(now),
    ]);
    const request = await readRequest(reservation.requestId);
    const counts = await readCounts(id(10), ipHash(10));

    expect(["completed", "expired"]).toContain(request?.status);
    if (request?.status === "completed") {
      expect(results[0]).toMatchObject({ kind: "settled", status: "completed" });
      expect(counts).toEqual({
        client: { successCount: 4, reservedCount: 0 },
        ip: { successCount: 4, reservedCount: 0 },
      });
    } else {
      expect(results[0]).toMatchObject({ kind: "expired", status: "expired" });
      expect(counts).toEqual({
        client: { successCount: 0, reservedCount: 0 },
        ip: { successCount: 0, reservedCount: 0 },
      });
    }
  });
});
