import { describe, expect, test } from "bun:test";
import { parseTimesheetTimeCell } from "./timesheet-utils";

describe("timesheet clock-time parsing", () => {
  test("normalizes strings, Excel fractional-day cells and Date cells", () => {
    expect(parseTimesheetTimeCell("8:05")).toBe("08:05");
    expect(parseTimesheetTimeCell("17:45:30")).toBe("17:45");
    expect(parseTimesheetTimeCell(0)).toBe("00:00");
    expect(parseTimesheetTimeCell(0.5)).toBe("12:00");
    expect(parseTimesheetTimeCell(new Date("1899-12-30T08:30:00.000Z"))).toBe("08:30");
  });

  test("keeps blank cells empty and rejects invalid or non-time values", () => {
    expect(parseTimesheetTimeCell(null)).toBeNull();
    expect(parseTimesheetTimeCell(undefined)).toBeNull();
    expect(parseTimesheetTimeCell("  ")).toBeNull();
    expect(() => parseTimesheetTimeCell("24:00")).toThrow();
    expect(() => parseTimesheetTimeCell("12:60")).toThrow();
    expect(() => parseTimesheetTimeCell(1)).toThrow();
  });
});
