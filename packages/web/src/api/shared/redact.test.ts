import { describe, expect, test } from "bun:test";
import { maskAccountNumber, redactForAudit } from "./redact";

describe("redactForAudit", () => {
  test("masks an account number to its last 4, at any depth", () => {
    const out = redactForAudit({ merchantId: "m1", accountNumber: "8004400440", nested: { rows: [{ accountNumber: "1234 5678 9012" }] } });
    expect(out).toEqual({ merchantId: "m1", accountNumber: "****0440", nested: { rows: [{ accountNumber: "****9012" }] } });
    expect(JSON.stringify(out)).not.toContain("8004400440");
  });
  test("a payout file body is replaced by its size; the masked rows stay", () => {
    const csv = "beneficiary,account,amount\nX,8004400440,100.00\n";
    const out = redactForAudit({ csv, rows: [{ account: "****0440" }], totalCents: 10000 }) as Record<string, unknown>;
    expect(out.csv).toBe(`[${csv.length} bytes]`);
    expect(out.totalCents).toBe(10000);
    expect(JSON.stringify(out)).not.toContain("8004400440");
  });
  test("payout-file rows: a digit-string `account` is masked, a ledger `account` is not", () => {
    const out = redactForAudit({
      rows: [{ beneficiary: "M4 UI Traders", account: "8004400440", amount: "4975.00" }],
      ledger: [{ account: "merchant_payable", balanceCents: 5 }, { account: { id: "a1", code: "1200" } }],
    });
    expect(out).toEqual({
      rows: [{ beneficiary: "M4 UI Traders", account: "****0440", amount: "4975.00" }],
      ledger: [{ account: "merchant_payable", balanceCents: 5 }, { account: { id: "a1", code: "1200" } }],
    });
    expect(redactForAudit({ account: "800-440-0440" })).toEqual({ account: "****0440" });
  });
  test("tokens, secrets and OTP codes are dropped; null stays null", () => {
    const out = redactForAudit({ accessToken: "eyJ", refreshToken: "r", devCode: "123456", password: null, user: { id: "u" } });
    expect(out).toEqual({ accessToken: "[redacted]", refreshToken: "[redacted]", devCode: "[redacted]", password: null, user: { id: "u" } });
  });
  test("dates, primitives and unrelated keys pass through untouched", () => {
    const d = new Date("2026-10-02T00:00:00Z");
    expect(redactForAudit({ at: d, code: "STL-1", n: 3, ok: true })).toEqual({ at: d, code: "STL-1", n: 3, ok: true });
    expect(redactForAudit("x")).toBe("x");
    expect(redactForAudit(null)).toBe(null);
    expect(redactForAudit(undefined)).toBe(undefined);
  });
  test("does not mutate its input", () => {
    const input = { accountNumber: "8004400440" };
    redactForAudit(input);
    expect(input.accountNumber).toBe("8004400440");
  });
  test("short account numbers are fully masked", () => {
    expect(maskAccountNumber("123")).toBe("****");
  });
});
