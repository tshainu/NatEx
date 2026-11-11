import { describe, expect, test } from "bun:test";
import { counterHistoryDateRange } from "./counter-history-date";

describe("counter history date presets", () => {
  test("uses the selected Colombo date for today and yesterday", () => {
    expect(counterHistoryDateRange("today", "2026-11-11")).toEqual({ startDate: "2026-11-11", endDate: "2026-11-11" });
    expect(counterHistoryDateRange("yesterday", "2026-11-11")).toEqual({ startDate: "2026-11-10", endDate: "2026-11-10" });
  });

  test("starts the week on Monday and includes today", () => {
    expect(counterHistoryDateRange("this_week", "2026-11-11")).toEqual({ startDate: "2026-11-09", endDate: "2026-11-11" });
    expect(counterHistoryDateRange("this_week", "2026-11-08")).toEqual({ startDate: "2026-11-02", endDate: "2026-11-08" });
  });

  test("includes the first day of the current month and year through today", () => {
    expect(counterHistoryDateRange("this_month", "2024-02-29")).toEqual({ startDate: "2024-02-01", endDate: "2024-02-29" });
    expect(counterHistoryDateRange("this_year", "2026-11-11")).toEqual({ startDate: "2026-01-01", endDate: "2026-11-11" });
  });

  test("leaves all-time and custom ranges for the caller to resolve", () => {
    expect(counterHistoryDateRange("all", "2026-11-11")).toEqual({});
    expect(counterHistoryDateRange("custom", "2026-11-11")).toEqual({});
  });
});
