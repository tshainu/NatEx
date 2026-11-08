import { describe, expect, test } from "bun:test";
import {
  NATEX_COMPANY_PHONE,
  NATEX_WEBSITE,
  receiptHeaderMetadata,
  receiptText,
  THERMAL_RECEIPT_PRINT_CSS,
} from "./receipt-print-metadata";

describe("Operations thermal receipt metadata", () => {
  test("uses the configured NatEx website and contact number", () => {
    expect(receiptHeaderMetadata({ name: "Colombo Central", address: "128 Union Place" })).toEqual({
      branchName: "Colombo Central",
      branchAddress: "128 Union Place",
      branchPhone: "Not configured",
      website: NATEX_WEBSITE,
      companyPhone: "Not configured",
    });
  });

  test("accepts verified settings contacts without treating the old sample number as data", () => {
    expect(receiptHeaderMetadata(null, { website: "receipts.example", companyPhone: "+94112223344" })).toMatchObject({
      website: "receipts.example",
      companyPhone: "+94112223344",
    });
    expect(NATEX_COMPANY_PHONE).toBe("");
  });

  test("does not invent a branch phone when the branch API has no phone field", () => {
    expect(receiptHeaderMetadata({ name: "Kandy Regional Hub", address: "Katugastota Rd" }).branchPhone)
      .toBe("Not configured");
    expect(receiptText("   ")).toBe("Not configured");
    expect(receiptText("+94112223344")).toBe("+94112223344");
  });

  test("keeps blank settings contacts printable without a made-up phone", () => {
    expect(receiptHeaderMetadata({ name: "Mannar Hub", phone: "   " }, { website: null, companyPhone: null })).toEqual({
      branchName: "Mannar Hub",
      branchAddress: "Not configured",
      branchPhone: "Not configured",
      website: NATEX_WEBSITE,
      companyPhone: "Not configured",
    });
  });

  test("keeps the thermal print width and allows variable receipt height", () => {
    expect(THERMAL_RECEIPT_PRINT_CSS).toContain("@page { size: auto; margin: 0 }");
    expect(THERMAL_RECEIPT_PRINT_CSS).toContain("width: 80mm !important");
    expect(THERMAL_RECEIPT_PRINT_CSS).toContain("padding: 4mm !important");
    expect(THERMAL_RECEIPT_PRINT_CSS).not.toContain("size: 80mm auto");
    expect(THERMAL_RECEIPT_PRINT_CSS).toContain("overflow: visible !important");
    expect(THERMAL_RECEIPT_PRINT_CSS).not.toContain("size: A5");
    expect(THERMAL_RECEIPT_PRINT_CSS).not.toContain("size:A6");
    expect(THERMAL_RECEIPT_PRINT_CSS).not.toContain("height: 140mm");
  });
});
