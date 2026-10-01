/**
 * Bulk-booking CSV preparation — pure unit tests. Money and weight must cross
 * from a merchant's spreadsheet to integer cents/grams without a float.
 */
import { describe, expect, test } from "bun:test";
import { chunk, prepareBulkCsv, TEMPLATE_HEADER } from "./bulk-csv";
import { kgToGrams, rupeesToCents } from "./csv";

const HEADER = TEMPLATE_HEADER.join(",");

describe("kgToGrams", () => {
  test.each([
    ["1", 1000],
    ["0.75", 750],
    ["1.005", 1005],
    ["2.5 kg", 2500],
    ["1,250", 1_250_000],
  ])("%s → %d g", (raw, grams) => expect(kgToGrams(raw)).toEqual({ grams }));
  test.each(["", "abc", "-1", "1.0005", "1e3"])("%p refused", (raw) => {
    expect("error" in kgToGrams(raw)).toBe(true);
  });
});

describe("rupeesToCents (used by bulk rows)", () => {
  test("0.1 + 0.2 class values are exact", () => {
    expect(rupeesToCents("0.29")).toEqual({ cents: 29 });
    expect(rupeesToCents("1234.57")).toEqual({ cents: 123457 });
    expect(rupeesToCents("Rs. 12,345.6")).toEqual({ cents: 1234560 });
  });
  test("a third decimal is refused, not rounded", () => {
    expect("error" in rupeesToCents("10.005")).toBe(true);
  });
});

describe("prepareBulkCsv", () => {
  test("happy row maps to the API payload with integer money", () => {
    const f = prepareBulkCsv(`${HEADER}\nORD-1,Dilani Perera,0771234567,"No. 12, Temple Road, Kandy",0.75,,,,2450.50,3000`);
    expect(f.fileErrors).toEqual([]);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]!.errors).toEqual([]);
    expect(f.rows[0]!.payload).toEqual({
      line: 2,
      orderRef: "ORD-1",
      consigneeName: "Dilani Perera",
      consigneePhone: "0771234567",
      destAddress: "No. 12, Temple Road, Kandy",
      weightGrams: 750,
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      codAmountCents: 245050,
      declaredValueCents: 300000,
    });
  });

  test("headers match case/punctuation-insensitively and by alias, in any order", () => {
    const f = prepareBulkCsv(`Phone,Customer Name,Address,Weight,COD\n0771234567,Kamal,12 Hill St Kandy,1,100`);
    expect(f.fileErrors).toEqual([]);
    expect(f.rows[0]!.payload).toMatchObject({ consigneeName: "Kamal", weightGrams: 1000, codAmountCents: 10000 });
  });

  test("missing required column is a file error", () => {
    const f = prepareBulkCsv(`consignee_name,consignee_phone\nA,0771234567`);
    expect(f.rows).toEqual([]);
    expect(f.fileErrors[0]).toContain("delivery_address");
    expect(f.fileErrors[0]).toContain("weight_kg");
  });

  test("empty file and header-only file", () => {
    expect(prepareBulkCsv("").fileErrors).toEqual(["The file is empty."]);
    expect(prepareBulkCsv(HEADER).fileErrors[0]).toContain("no parcels");
  });

  test("bad money/weight/dimension rows carry per-field errors and no payload", () => {
    const f = prepareBulkCsv(`${HEADER}\nA,Name One,0771234567,Somewhere long,abc,10.5,,,12.345,\nB,Name Two,0771234567,Somewhere long,1,,,,,`);
    const [bad, good] = f.rows;
    expect(bad!.payload).toBeNull();
    expect(bad!.errors.map((e) => e.field).sort()).toEqual(["cod_rs", "length_cm", "weight_kg"]);
    expect(good!.payload).not.toBeNull();
  });

  test("duplicate order refs are caught across the whole file", () => {
    const rows = Array.from({ length: 150 }, (_, i) => `R${i === 149 ? 0 : i},N ${i},0771234567,Address ${i} long,1,,,,,`);
    const f = prepareBulkCsv(`${HEADER}\n${rows.join("\n")}`);
    const dup = f.rows[149]!;
    expect(dup.errors).toEqual([{ field: "order_ref", message: "Duplicate order ref — first used on line 2" }]);
  });

  test("line numbers follow the spreadsheet, including quoted line breaks", () => {
    const f = prepareBulkCsv(`${HEADER}\nA,N,0771234567,"Line one\nline two",1,,,,,\nB,N2,0771234567,Address long,1,,,,,`);
    expect(f.rows.map((r) => r.line)).toEqual([2, 4]);
  });

  test("unknown columns are reported, not fatal", () => {
    const f = prepareBulkCsv(`${HEADER},colour\nA,N,0771234567,Address long,1,,,,,,red`);
    expect(f.unknownColumns).toEqual(["colour"]);
    expect(f.rows[0]!.payload).not.toBeNull();
  });
});

describe("chunk", () => {
  test("250 rows → 100/100/50", () => {
    expect(chunk(Array.from({ length: 250 }, (_, i) => i), 100).map((c) => c.length)).toEqual([100, 100, 50]);
  });
});
