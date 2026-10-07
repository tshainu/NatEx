import { describe, expect, test } from "bun:test";
import { awbRangeMatchesQuery } from "./awb-batch-search";

const START = "NX1234567000";
const END = "NX1234567999";

describe("AWB batch register range search", () => {
  test("matches a full AWB anywhere inside the range, not only its endpoints", () => {
    expect(awbRangeMatchesQuery("NX1234567500", START, END)).toBe(true);
    expect(awbRangeMatchesQuery("1234567500", START, END)).toBe(true);
    expect(awbRangeMatchesQuery("NX1234567000", START, END)).toBe(true);
    expect(awbRangeMatchesQuery("NX1234567999", START, END)).toBe(true);
  });

  test("matches a numeric prefix when its possible range intersects the batch", () => {
    expect(awbRangeMatchesQuery("NX1234567", START, END)).toBe(true);
    expect(awbRangeMatchesQuery("123456", START, END)).toBe(true);
    expect(awbRangeMatchesQuery("NX-1234567500", START, END)).toBe(true);
  });

  test("does not match an AWB prefix outside the batch", () => {
    expect(awbRangeMatchesQuery("NX1234568", START, END)).toBe(false);
    expect(awbRangeMatchesQuery("NX1234566999", START, END)).toBe(false);
    expect(awbRangeMatchesQuery("NX1234568000", START, END)).toBe(false);
  });

  test("does not treat batch IDs or arbitrary text as an AWB", () => {
    expect(awbRangeMatchesQuery("NXB-20261007-FYCWQW1NWQ", START, END)).toBe(false);
    expect(awbRangeMatchesQuery("merchant name", START, END)).toBe(false);
    expect(awbRangeMatchesQuery("NX", START, END)).toBe(false);
  });
});
