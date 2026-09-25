import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_DAILY_ACCESSES,
  hasReachedDailyAccessLimit,
  normalizeDailyAccessLimit,
  startOfDayInTimeZoneIso,
} from "./daily-access.ts";

describe("daily access configuration", () => {
  it("accepts the configured range and falls back for invalid values", () => {
    expect(normalizeDailyAccessLimit(0)).toBe(0);
    expect(normalizeDailyAccessLimit(12)).toBe(12);
    expect(normalizeDailyAccessLimit(-1)).toBe(DEFAULT_MAX_DAILY_ACCESSES);
    expect(normalizeDailyAccessLimit(101)).toBe(DEFAULT_MAX_DAILY_ACCESSES);
    expect(normalizeDailyAccessLimit("invalid")).toBe(DEFAULT_MAX_DAILY_ACCESSES);
  });

  it("treats zero as unlimited and blocks when the configured limit is reached", () => {
    expect(hasReachedDailyAccessLimit(500, 0)).toBe(false);
    expect(hasReachedDailyAccessLimit(2, 3)).toBe(false);
    expect(hasReachedDailyAccessLimit(3, 3)).toBe(true);
  });

  it("starts the daily window at midnight in Sao Paulo", () => {
    expect(startOfDayInTimeZoneIso(new Date("2026-09-16T12:00:00.000Z")))
      .toBe("2026-09-16T03:00:00.000Z");
    expect(startOfDayInTimeZoneIso(new Date("2018-12-01T12:00:00.000Z")))
      .toBe("2018-12-01T02:00:00.000Z");
  });
});
