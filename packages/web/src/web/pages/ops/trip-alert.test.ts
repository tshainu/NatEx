import { describe, expect, test } from "bun:test";
import { isTripOverdue } from "./trip-alert";

const NOW = new Date("2026-11-09T10:00:00.000Z").getTime();
const ONE_HOUR_BEFORE = new Date(NOW - 60 * 60 * 1000).toISOString();

describe("isTripOverdue", () => {
  test("does not alert at exactly the one-hour boundary, but does after it", () => {
    expect(isTripOverdue("departed", ONE_HOUR_BEFORE, NOW)).toBe(false);
    expect(
      isTripOverdue(
        "departed",
        new Date(NOW - 60 * 60 * 1000 - 1).toISOString(),
        NOW,
      ),
    ).toBe(true);
  });

  test("does not alert for a trip already arrived", () => {
    expect(isTripOverdue("arrived", new Date(NOW - 2 * 60 * 60 * 1000), NOW)).toBe(false);
    expect(
      isTripOverdue(
        "departed",
        new Date(NOW - 2 * 60 * 60 * 1000),
        NOW,
        new Date(NOW - 5 * 60 * 1000),
      ),
    ).toBe(false);
  });

  test("does not alert when the ETA is missing or invalid", () => {
    expect(isTripOverdue("departed", null, NOW)).toBe(false);
    expect(isTripOverdue("departed", undefined, NOW)).toBe(false);
    expect(isTripOverdue("departed", "not-a-date", NOW)).toBe(false);
  });

  test("does not alert before a departed trip is more than one hour late", () => {
    expect(isTripOverdue("departed", new Date(NOW - 30 * 60 * 1000), NOW)).toBe(false);
    expect(isTripOverdue("loading", new Date(NOW - 2 * 60 * 60 * 1000), NOW)).toBe(false);
  });
});
