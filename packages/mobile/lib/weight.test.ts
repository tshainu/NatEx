import { describe, expect, test } from "bun:test";
import {
  chargeableWeightGrams,
  isValidWeightLimitGrams,
  kilogramsLabel,
  MAX_TARIFF_WEIGHT_GRAMS,
  parseKilograms,
} from "./weight";

describe("Merchant app weight handling", () => {
  test("parses weights through the 30 kg tariff ceiling", () => {
    expect(parseKilograms("1.25")).toBe(1250);
    expect(parseKilograms("30")).toBe(MAX_TARIFF_WEIGHT_GRAMS);
    expect(parseKilograms("30.001")).toBeNull();
    expect(parseKilograms("0")).toBeNull();
  });

  test("chargeable weight is the greater of scale and volumetric weight", () => {
    expect(chargeableWeightGrams(1000, 40, 30, 20)).toBe(4800);
    expect(chargeableWeightGrams(6000, 10, 10, 10)).toBe(6000);
  });

  test("accepts only 0.5 kg settings up to 30 kg", () => {
    expect(isValidWeightLimitGrams(500)).toBe(true);
    expect(isValidWeightLimitGrams(20_000)).toBe(true);
    expect(isValidWeightLimitGrams(30_000)).toBe(true);
    expect(isValidWeightLimitGrams(20_250)).toBe(false);
    expect(isValidWeightLimitGrams(30_500)).toBe(false);
    expect(kilogramsLabel(20_500)).toBe("20.5");
  });
});
