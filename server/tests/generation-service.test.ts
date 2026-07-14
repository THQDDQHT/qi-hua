import { describe, expect, test } from "bun:test";
import { PublicGenerationError } from "../src/domain/public-generation";
import { createGenerationService } from "../src/services/generation-service";
import type { ImageProvider, ProviderImage } from "../src/services/image-provider";
import type { GenerationInput } from "../src/services/image-validation";
import type { QuotaSnapshot } from "../src/services/quota-snapshot";
import type { createQuotaService } from "../src/services/quota-service";

type QuotaService = Pick<
  ReturnType<typeof createQuotaService>,
  "reserveQuota" | "claimForExecution" | "settleQuota"
>;

type QuotaOverrides = Partial<QuotaService>;

const quota: QuotaSnapshot = {
  limit: 10,
  used: 2,
  reserved: 0,
  remaining: 8,
  resetAt: "2026-07-14T16:00:00.000Z",
};

const generation: GenerationInput = {
  requestKey: "request-key",
  prompt: "一只猫",
  count: 1,
  size: "1:1",
  quality: "high",
};

const image: ProviderImage = {
  mimeType: "image/png",
  data: "temporary-image-marker",
};

function fakeQuotaService(overrides: QuotaOverrides = {}): QuotaService {
  return {
    reserveQuota: async () => ({ kind: "reserved", requestId: "request-id", status: "reserved" }),
    claimForExecution: async () => ({ kind: "claimed", requestId: "request-id", status: "running" }),
    settleQuota: async () => ({ kind: "settled", status: "completed", quota }),
    ...overrides,
  };
}

function fakeProvider(handler: (signal: AbortSignal, index: number) => Promise<ProviderImage> = async () => image) {
  let calls = 0;
  const execute = (signal: AbortSignal) => handler(signal, calls++);
  const provider: ImageProvider = {
    generateSlot: ({ signal }) => execute(signal),
    editSlot: ({ signal }) => execute(signal),
  };
  return { provider, get calls() { return calls; } };
}

function service(quotaService: QuotaService, provider: ImageProvider, overrides: { upstreamTimeoutMs?: number } = {}) {
  return createGenerationService({
    quotaService,
    provider,
    idempotencySecret: "idempotency-test-secret".padEnd(32, "x"),
    reservationTtlSeconds: 600,
    upstreamTimeoutMs: overrides.upstreamTimeoutMs ?? 1000,
    now: () => new Date("2026-07-14T02:00:00.000Z"),
  });
}

function execute(
  quotaService: QuotaService,
  provider: ImageProvider,
  input: Partial<GenerationInput> = {},
  overrides: { upstreamTimeoutMs?: number } = {},
) {
  return service(quotaService, provider, overrides).execute({
    operation: "generation",
    generation: { ...generation, ...input },
    references: [],
    clientId: "client-id",
    ipHash: new Uint8Array(32).fill(1),
    quotaDate: "2026-07-14",
  });
}

describe("GenerationService", () => {
  test("预占失败时不领取、不结算也不调用供应商", async () => {
    const calls: string[] = [];
    const quotaService = fakeQuotaService({
      reserveQuota: async () => {
        calls.push("reserve");
        throw new PublicGenerationError("QUOTA_EXHAUSTED");
      },
      claimForExecution: async () => {
        calls.push("claim");
        return { kind: "claimed", requestId: "request-id", status: "running" };
      },
      settleQuota: async () => {
        calls.push("settle");
        return { kind: "settled", status: "failed", quota };
      },
    });
    const provider = fakeProvider();

    await expect(execute(quotaService, provider.provider)).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
    expect(calls).toEqual(["reserve"]);
    expect(provider.calls).toBe(0);
  });

  test("运行中重放不再次领取或调用供应商", async () => {
    let claims = 0;
    const quotaService = fakeQuotaService({
      reserveQuota: async () => ({ kind: "replay", requestId: "request-id", status: "running" }),
      claimForExecution: async () => {
        claims++;
        return { kind: "claimed", requestId: "request-id", status: "running" };
      },
    });
    const provider = fakeProvider();

    await expect(execute(quotaService, provider.provider)).resolves.toEqual({ status: "running", replayed: true });
    expect(claims).toBe(0);
    expect(provider.calls).toBe(0);
  });

  test("终态重放返回空结果和最新额度", async () => {
    let settlements = 0;
    const quotaService = fakeQuotaService({
      reserveQuota: async () => ({ kind: "replay", requestId: "request-id", status: "completed" }),
      settleQuota: async ({ successCount }) => {
        settlements++;
        expect(successCount).toBe(0);
        return { kind: "already-settled", status: "completed", quota };
      },
    });
    const provider = fakeProvider();

    await expect(execute(quotaService, provider.provider)).resolves.toEqual({
      status: "completed",
      replayed: true,
      results: [],
      quota,
    });
    expect(settlements).toBe(1);
    expect(provider.calls).toBe(0);
  });

  test("未取得执行权时不调用供应商", async () => {
    const quotaService = fakeQuotaService({
      claimForExecution: async () => ({ kind: "not-claimed", requestId: "request-id", status: "running" }),
    });
    const provider = fakeProvider();

    await expect(execute(quotaService, provider.provider)).resolves.toEqual({ status: "running", replayed: true });
    expect(provider.calls).toBe(0);
  });

  test("四槽两成功只按两个成功结算", async () => {
    const settlements: Array<{ successCount: number; errorCode?: string }> = [];
    const quotaService = fakeQuotaService({
      settleQuota: async (input) => {
        settlements.push(input);
        return { kind: "settled", status: "partial", quota };
      },
    });
    const provider = fakeProvider(async (_signal, index) => {
      if (index === 1) throw new PublicGenerationError("PROVIDER_REJECTED");
      if (index === 3) throw new Error("private provider failure");
      return { ...image, data: `image-${index}` };
    });

    const result = await execute(quotaService, provider.provider, { count: 4 });

    expect(provider.calls).toBe(4);
    expect(result).toMatchObject({ status: "partial", replayed: false });
    expect("results" in result && result.results.map(({ index, status }) => ({ index, status }))).toEqual([
      { index: 0, status: "success" },
      { index: 1, status: "failed" },
      { index: 2, status: "success" },
      { index: 3, status: "failed" },
    ]);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ successCount: 2, errorCode: "SERVICE_UNAVAILABLE" });
  });

  test("共享超时中止所有槽位后仍完成一次结算", async () => {
    let settlements = 0;
    const quotaService = fakeQuotaService({
      settleQuota: async (input) => {
        settlements++;
        expect(input).toMatchObject({ successCount: 0, errorCode: "PROVIDER_TIMEOUT" });
        return { kind: "settled", status: "failed", quota };
      },
    });
    const provider = fakeProvider((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new PublicGenerationError("PROVIDER_TIMEOUT")), { once: true });
    }));

    const result = await execute(quotaService, provider.provider, { count: 2 }, { upstreamTimeoutMs: 5 });

    expect(settlements).toBe(1);
    expect(result).toMatchObject({ status: "failed", replayed: false });
    expect("results" in result && result.results.map((item) => item.status)).toEqual(["failed", "failed"]);
  });

  test.each([
    ["already-settled", "completed", "completed"],
    ["expired", "expired", "failed"],
  ] as const)("%s 结算不会交付临时图片", async (kind, settlementStatus, responseStatus) => {
    const quotaService = fakeQuotaService({
      settleQuota: async () => kind === "expired"
        ? { kind: "expired", status: "expired", quota }
        : { kind: "already-settled", status: "completed", quota },
    });
    const provider = fakeProvider();

    const result = await execute(quotaService, provider.provider);

    expect(result).toEqual({
      status: responseStatus,
      replayed: true,
      results: [],
      quota,
    });
    expect(JSON.stringify(result)).not.toContain(image.data);
  });

  test("结算异常时拒绝请求且不泄漏已生成图片", async () => {
    const quotaService = fakeQuotaService({
      settleQuota: async () => {
        throw new Error("private database failure");
      },
    });
    const provider = fakeProvider();

    await expect(execute(quotaService, provider.provider)).rejects.toThrow("private database failure");
  });
});
