import { describe, expect, test } from "bun:test";
import { formatQuotaSnapshot, getShanghaiQuotaWindow } from "../src/services/quota-snapshot";

describe("quota snapshot", () => {
  test("北京时间零点切换额度日期与重置时间", () => {
    expect(getShanghaiQuotaWindow(new Date("2026-07-12T15:59:59.999Z"))).toEqual({
      quotaDate: "2026-07-12",
      resetAt: "2026-07-12T16:00:00.000Z",
    });
    expect(getShanghaiQuotaWindow(new Date("2026-07-12T16:00:00.000Z"))).toEqual({
      quotaDate: "2026-07-13",
      resetAt: "2026-07-13T16:00:00.000Z",
    });
  });

  test("额度快照统一钳制 remaining 并包含 resetAt", () => {
    expect(formatQuotaSnapshot({
      limit: 10,
      counts: { successCount: 8, reservedCount: 4 },
      resetAt: "2026-07-13T16:00:00.000Z",
    })).toEqual({
      limit: 10,
      used: 8,
      reserved: 4,
      remaining: 0,
      resetAt: "2026-07-13T16:00:00.000Z",
    });
    expect(formatQuotaSnapshot({
      limit: 10,
      counts: { successCount: 0, reservedCount: 0 },
      resetAt: "2026-07-13T16:00:00.000Z",
    })).toEqual({
      limit: 10,
      used: 0,
      reserved: 0,
      remaining: 10,
      resetAt: "2026-07-13T16:00:00.000Z",
    });
  });
});
