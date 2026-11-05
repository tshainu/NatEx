import { describe, expect, test } from "bun:test";
import { HR_PROFILE_PHOTO_MAX_BYTES, isValidEmployeeProfilePhoto, isValidIsoDate, isValidLocalTime } from "./validation";

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


describe("HR attendance clock-time validation", () => {
  test("accepts zero-padded 24-hour HH:MM values", () => {
    expect(isValidLocalTime("00:00")).toBe(true);
    expect(isValidLocalTime("08:05")).toBe(true);
    expect(isValidLocalTime("23:59")).toBe(true);
  });

  test("rejects malformed, out-of-range and non-zero-padded times", () => {
    for (const value of ["24:00", "12:60", "8:30", "8:3", "08:30 AM", ""]) {
      expect(isValidLocalTime(value)).toBe(false);
    }
  });
});

describe("HR employee profile-photo validation", () => {
  test("accepts JPEG/PNG files up to 5 MB", () => {
    expect(isValidEmployeeProfilePhoto("image/jpeg", 1)).toBe(true);
    expect(isValidEmployeeProfilePhoto("image/png", HR_PROFILE_PHOTO_MAX_BYTES)).toBe(true);
  });

  test("rejects other file types, empty files and files over 5 MB", () => {
    expect(isValidEmployeeProfilePhoto("application/pdf", 1024)).toBe(false);
    expect(isValidEmployeeProfilePhoto("image/webp", 1024)).toBe(false);
    expect(isValidEmployeeProfilePhoto("image/jpeg", 0)).toBe(false);
    expect(isValidEmployeeProfilePhoto("image/png", HR_PROFILE_PHOTO_MAX_BYTES + 1)).toBe(false);
  });
});
