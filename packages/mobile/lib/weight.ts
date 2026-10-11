export const MAX_TARIFF_WEIGHT_GRAMS = 30_000;
export const DEFAULT_VOLUMETRIC_DIVISOR_CM3_PER_KG = 5000;

export function isValidWeightLimitGrams(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 500 && (value as number) <= MAX_TARIFF_WEIGHT_GRAMS && (value as number) % 500 === 0;
}

export function parseKilograms(raw: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,3}))?$/.exec(raw.trim());
  if (!match) return null;
  const grams = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  return grams > 0 && grams <= MAX_TARIFF_WEIGHT_GRAMS ? grams : null;
}

export function volumetricWeightGrams(
  lengthCm: number | null,
  widthCm: number | null,
  heightCm: number | null,
  divisor = DEFAULT_VOLUMETRIC_DIVISOR_CM3_PER_KG,
): number {
  if (!lengthCm || !widthCm || !heightCm) return 0;
  return Math.floor((lengthCm * widthCm * heightCm * 1000 + divisor - 1) / divisor);
}

export function chargeableWeightGrams(
  actualGrams: number,
  lengthCm: number | null,
  widthCm: number | null,
  heightCm: number | null,
): number {
  return Math.max(actualGrams, volumetricWeightGrams(lengthCm, widthCm, heightCm));
}

export function kilogramsLabel(grams: number): string {
  return grams % 1000 === 0 ? String(grams / 1000) : (grams / 1000).toFixed(1);
}
