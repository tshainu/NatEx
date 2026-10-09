import { describe, expect, test } from "bun:test";
import { chunk, prepareBulkCsv, TEMPLATE_HEADER } from "./bulk-csv";
import { kgToGrams, rupeesToCents } from "./csv";

const HEADER = TEMPLATE_HEADER.join(",");
function row({
  ref = "ORD-1",
  awb = "NX1234567890",
  name = "Meena Ganesan",
  phone = "0771234567",
  line1 = "No. 12, Temple Road",
  line2 = "",
  district = "Kandy",
  province = "Central Province",
  legacyAddress = "",
  weight = "0.75",
  length = "",
  width = "",
  height = "",
  cod = "2450.50",
  declared = "3000",
}: Record<string, string> = {}) {
  return [ref, awb, name, phone, line1, line2, district, province, legacyAddress, weight, length, width, height, cod, declared]
    .map((value) => /[,\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(",");
}

describe("kgToGrams", () => {
  test.each([["1", 1000], ["0.75", 750], ["1.005", 1005], ["2.5 kg", 2500], ["1,250", 1_250_000]])("%s → %d g", (raw, grams) => expect(kgToGrams(raw)).toEqual({ grams }));
  test.each(["", "abc", "-1", "1.0005", "1e3"])("%p refused", (raw) => expect("error" in kgToGrams(raw)).toBe(true));
});

describe("rupeesToCents (used by bulk rows)", () => {
  test("0.1 + 0.2 class values are exact", () => {
    expect(rupeesToCents("0.29")).toEqual({ cents: 29 });
    expect(rupeesToCents("1234.57")).toEqual({ cents: 123457 });
    expect(rupeesToCents("Rs. 12,345.6")).toEqual({ cents: 1234560 });
  });
  test("a third decimal is refused, not rounded", () => expect("error" in rupeesToCents("10.005")).toBe(true));
});

describe("prepareBulkCsv", () => {
  test("maps supplied AWB and structured address to canonical API payload", () => {
    const f = prepareBulkCsv(`${HEADER}\n${row()}`);
    expect(f.fileErrors).toEqual([]);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]!.errors).toEqual([]);
    expect(f.rows[0]!.payload).toEqual({
      line: 2,
      awb: "NX1234567890",
      orderRef: "ORD-1",
      consigneeName: "Meena Ganesan",
      consigneePhone: "0771234567",
      destAddress: "No. 12, Temple Road, Kandy, Central Province",
      weightGrams: 750,
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      codAmountCents: 245050,
      declaredValueCents: 300000,
    });
  });

  test("accepts legacy delivery_address plus AWB header aliases and any column order", () => {
    const f = prepareBulkCsv(`Sticker,Phone,Customer Name,Address,Weight,COD\nNX1234567890,0771234567,Kamal,12 Hill St Kandy,1,100`);
    expect(f.fileErrors).toEqual([]);
    expect(f.rows[0]!.payload).toMatchObject({ awb: "NX1234567890", consigneeName: "Kamal", destAddress: "12 Hill St Kandy", weightGrams: 1000, codAmountCents: 10000 });
  });

  test("requires AWB and at least one address representation in the header", () => {
    const f = prepareBulkCsv("consignee_name,consignee_phone,weight_kg\nA,0771234567,1");
    expect(f.rows).toEqual([]);
    expect(f.fileErrors[0]).toContain("awb");
    expect(f.fileErrors[0]).toContain("delivery_address or address_line1 + district + province");
  });

  test("empty file and header-only file", () => {
    expect(prepareBulkCsv("").fileErrors).toEqual(["The file is empty."]);
    expect(prepareBulkCsv(HEADER).fileErrors[0]).toContain("no parcels");
  });

  test("bad money/weight/dimensions and invalid district/province are row errors", () => {
    const invalid = row({ weight: "abc", length: "10.5", cod: "12.345", district: "Kandy", province: "Western Province" });
    const f = prepareBulkCsv(`${HEADER}\n${invalid}`);
    expect(f.rows[0]!.payload).toBeNull();
    expect(f.rows[0]!.errors.map((e) => e.field).sort()).toEqual(["cod_rs", "district", "length_cm", "weight_kg"]);
  });

  test("bad and duplicate AWBs are caught locally", () => {
    const f = prepareBulkCsv(`${HEADER}\n${row({ awb: "bad" })}\n${row({ ref: "ORD-2" })}\n${row({ ref: "ORD-3" })}`);
    expect(f.rows[0]!.errors[0]?.field).toBe("awb");
    expect(f.rows[1]!.errors).toEqual([]);
    expect(f.rows[2]!.errors).toEqual([{ field: "awb", message: "Duplicate AWB — first used on line 3." }]);
  });

  test("duplicate order refs are caught across the whole file", () => {
    const rows = Array.from({ length: 150 }, (_, i) => row({ ref: `R${i === 149 ? 0 : i}`, awb: `NX${String(1_000_000_000 + i).padStart(10, "0")}`, name: `N ${i}`, cod: "", declared: "" }));
    const f = prepareBulkCsv(`${HEADER}\n${rows.join("\n")}`);
    expect(f.rows[149]!.errors).toEqual([{ field: "order_ref", message: "Duplicate order ref — first used on line 2" }]);
  });

  test("line numbers follow the spreadsheet, including quoted line breaks", () => {
    const f = prepareBulkCsv(`${HEADER}\n${row({ line1: "Line one\nline two", cod: "", declared: "" })}\n${row({ ref: "B", awb: "NX1234567891", name: "N2", line1: "Address long", cod: "", declared: "" })}`);
    expect(f.rows.map((r) => r.line)).toEqual([2, 4]);
  });

  test("unknown columns are reported, not fatal", () => {
    const f = prepareBulkCsv(`${HEADER},colour\n${row({ cod: "", declared: "" })},red`);
    expect(f.unknownColumns).toEqual(["colour"]);
    expect(f.rows[0]!.payload).not.toBeNull();
  });
});

describe("chunk", () => {
  test("250 rows → 100/100/50", () => expect(chunk(Array.from({ length: 250 }, (_, i) => i), 100).map((c) => c.length)).toEqual([100, 100, 50]));
});
