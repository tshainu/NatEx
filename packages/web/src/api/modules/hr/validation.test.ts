import { describe, expect, test } from "bun:test";
import { isValidIsoDate } from "./validation";

describe("HR calendar-date validation", () => {
  test("accepts real ISO dates including leap day", () => {
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2026-10-10")).toBe(true);
  });

  test("rejects impossible dates, out-of-range months, malformed text and years outside policy", () => {
    expect(isValidIsoDate("2025-02-29")).toBe(false);
    expect(isValidIsoDate("2026-04-31")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("26-10-10")).toBe(false);
    expect(isValidIsoDate("1800-01-01")).toBe(false);
  });
});
