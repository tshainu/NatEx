import { describe, expect, test } from "bun:test";
import {
  basisPoints,
  quote,
  roundUp,
  tariffProblems,
  volumetricGrams,
  type PricingBand,
  type PricingSlab,
  type PricingSurcharge,
} from "./pricing";

const version = { volumetricDivisor: 5000, roundingGrams: 500 };
const bands: PricingBand[] = [
  { band: "local", label: "Same branch", extraPerKgCents: 10_000 },
  { band: "outstation", label: "Other branch", extraPerKgCents: 15_000 },
];
const slabs: PricingSlab[] = [
  { band: "local", maxGrams: 1000, priceCents: 35_000 },
  { band: "local", maxGrams: 2000, priceCents: 45_000 },
  { band: "local", maxGrams: 5000, priceCents: 70_000 },
  { band: "outstation", maxGrams: 1000, priceCents: 45_000 },
  { band: "outstation", maxGrams: 5000, priceCents: 90_000 },
];
const surcharges: PricingSurcharge[] = [
  { code: "fuel", label: "Fuel", kind: "percent", amount: 750, mode: "always" },
  { code: "fragile", label: "Fragile handling", kind: "flat", amount: 10_000, mode: "on_request" },
];

describe("rate-card pricing arithmetic", () => {
  test("volumetric weight is ⌈L×W×H×1000 ÷ divisor⌉ grams", () => {
    expect(volumetricGrams(30, 20, 10, 5000)).toBe(1200); // 6000 cm³ → 1.2 kg
    expect(volumetricGrams(10, 10, 11, 5000)).toBe(220); // 1100 cm³ → 0.22 kg
    expect(volumetricGrams(7, 7, 7, 5000)).toBe(69); // 343 000 ÷ 5000 = 68.6 → 69
    expect(volumetricGrams(0, 10, 10, 5000)).toBe(0);
  });

  test("rounding is always up", () => {
    expect(roundUp(1, 500)).toBe(500);
    expect(roundUp(500, 500)).toBe(500);
    expect(roundUp(501, 500)).toBe(1000);
  });

  test("basis points round half up on integer cents", () => {
    expect(basisPoints(35_000, 750)).toBe(2625);
    expect(basisPoints(1, 5000)).toBe(1); // 0.5 → 1
    expect(basisPoints(1, 4999)).toBe(0);
  });

  test("a slab boundary is inclusive", () => {
    const q = quote(version, bands, slabs, surcharges, { band: "local", weightGrams: 1000 });
    expect(q.roundedGrams).toBe(1000);
    expect(q.freightCents).toBe(35_000);
  });

  test("one gram over a boundary moves up a slab", () => {
    const q = quote(version, bands, slabs, surcharges, { band: "local", weightGrams: 1001 });
    expect(q.roundedGrams).toBe(1500);
    expect(q.freightCents).toBe(45_000);
  });

  test("volumetric weight wins when the box is light but big", () => {
    const q = quote(version, bands, slabs, surcharges, {
      band: "local",
      weightGrams: 400,
      lengthCm: 40,
      widthCm: 30,
      heightCm: 20,
    });
    expect(q.volumetricGrams).toBe(4800);
    expect(q.chargeableGrams).toBe(4800);
    expect(q.roundedGrams).toBe(5000);
    expect(q.freightCents).toBe(70_000);
  });

  test("above the heaviest slab every started kg costs the band's overflow rate", () => {
    const q = quote(version, bands, slabs, surcharges, { band: "outstation", weightGrams: 6200 });
    // 6200 → 6500 g; 1500 g over 5000 → 2 started kg × 150.00
    expect(q.roundedGrams).toBe(6500);
    expect(q.freightCents).toBe(90_000 + 2 * 15_000);
  });

  test("always-on percent surcharge and requested flat surcharge add up exactly", () => {
    const q = quote(version, bands, slabs, surcharges, {
      band: "local",
      weightGrams: 800,
      requested: ["fragile"],
    });
    expect(q.lines.map((l) => [l.code, l.amountCents])).toEqual([
      ["freight", 35_000],
      ["fuel", 2625],
      ["fragile", 10_000],
    ]);
    expect(q.totalCents).toBe(47_625);
  });

  test("an on-request surcharge is not charged unless asked for", () => {
    const q = quote(version, bands, slabs, surcharges, { band: "local", weightGrams: 800 });
    expect(q.lines.some((l) => l.code === "fragile")).toBe(false);
    expect(q.totalCents).toBe(37_625);
  });

  test("bad input is refused, not priced", () => {
    expect(() => quote(version, bands, slabs, surcharges, { band: "local", weightGrams: 0 })).toThrow("above zero");
    expect(() => quote(version, bands, slabs, surcharges, { band: "air", weightGrams: 10 })).toThrow('no "air" band');
    expect(() =>
      quote(version, bands, slabs, surcharges, { band: "local", weightGrams: 10, requested: ["gold"] }),
    ).toThrow("Unknown surcharge");
    expect(() =>
      quote(version, bands, slabs, surcharges, { band: "local", weightGrams: 10, requested: ["fuel"] }),
    ).toThrow("always applies");
  });

  test("a valid tariff has no problems; broken ones are named", () => {
    expect(tariffProblems(version, bands, slabs, surcharges)).toEqual([]);
    const broken = tariffProblems(
      { volumetricDivisor: 10, roundingGrams: 0 },
      [...bands, { band: "express", label: "Express", extraPerKgCents: -1 }],
      [
        ...slabs,
        { band: "local", maxGrams: 2000, priceCents: 1 },
        { band: "ghost", maxGrams: 1, priceCents: 1 },
      ],
      [...surcharges, { code: "fuel", label: "dup", kind: "percent", amount: 20_000, mode: "always" }],
    );
    const text = broken.join("\n");
    expect(text).toContain("Volumetric divisor");
    expect(text).toContain("Rounding step");
    expect(text).toContain('Band "express" has no weight slabs');
    expect(text).toContain("per-kg overflow");
    expect(text).toContain("two slabs end at 2000 g");
    expect(text).toContain('unknown band "ghost"');
    expect(text).toContain('Surcharge "fuel" appears twice');
    expect(text).toContain("above 100%");
  });
});
