import { describe, expect, test } from "bun:test";
import {
  cleanOptionalReceiptPhone,
  cleanOptionalReceiptWebsite,
  receiptPhoneProblem,
  receiptWebsiteProblem,
} from "./receipt-contact";

describe("receipt contact validation", () => {
  test("keeps optional contacts blank instead of inventing a value", () => {
    expect(cleanOptionalReceiptPhone(undefined)).toBeNull();
    expect(cleanOptionalReceiptPhone("   ")).toBeNull();
    expect(cleanOptionalReceiptWebsite("")).toBeNull();
    expect(receiptPhoneProblem(null)).toBeNull();
    expect(receiptWebsiteProblem(null)).toBeNull();
  });

  test("accepts formatted business telephones and compacts whitespace", () => {
    expect(cleanOptionalReceiptPhone("  011   234  5678 ")).toBe("011 234 5678");
    expect(receiptPhoneProblem("011 234 5678")).toBeNull();
    expect(receiptPhoneProblem("+94 (11) 234-5678")).toBeNull();
  });

  test("rejects labels and implausible telephone values", () => {
    expect(receiptPhoneProblem("call us")).toContain("only digits");
    expect(receiptPhoneProblem("123")).toContain("at least 7 digits");
    expect(receiptPhoneProblem("1".repeat(16))).toContain("at most 15 digits");
  });

  test("allows the existing compact NatEx website and rejects unsafe website values", () => {
    expect(cleanOptionalReceiptWebsite("  natex.lk ")).toBe("natex.lk");
    expect(receiptWebsiteProblem("natex.lk")).toBeNull();
    expect(receiptWebsiteProblem("not a website")).toContain("without spaces");
    expect(receiptWebsiteProblem("\u0000natex.lk")).toContain("control characters");
  });
});
