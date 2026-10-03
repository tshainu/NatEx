/**
 * Rate-card arithmetic — pure, integer-only, no I/O (§9: money is integer
 * cents; rates are basis points). The DB side lives in rate-cards.ts.
 *
 * §15 q3 (zones, weight slabs, surcharges) is OPEN. This file is the ENGINE the
 * answer will be typed into; it does not encode any client-approved number.
 *
 *   chargeable g = max(actual g, ⌈L×W×H cm³ × 1000 ÷ divisor⌉)
 *   rounded g    = ⌈chargeable ÷ rounding⌉ × rounding
 *   freight      = first slab (by maxGrams, ascending) with maxGrams ≥ rounded,
 *                  else heaviest slab + ⌈(rounded − heaviest.maxGrams) ÷ 1000⌉ × extraPerKg
 *   surcharge    = flat cents, or ⌊freight × bp ÷ 10 000 + ½⌋ (half-up)
 *   total        = freight + Σ surcharges
 */

export interface PricingVersion {
  volumetricDivisor: number;
  roundingGrams: number;
}
export interface PricingBand {
  band: string;
  label: string;
  extraPerKgCents: number;
}
export interface PricingSlab {
  band: string;
  maxGrams: number;
  priceCents: number;
}
export interface PricingSurcharge {
  code: string;
  label: string;
  kind: "flat" | "percent";
  amount: number;
  mode: "always" | "on_request";
}
export interface QuoteInput {
  band: string;
  weightGrams: number;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  /** Codes of on_request surcharges the booking asks for. */
  requested?: string[];
}
export interface QuoteLine {
  code: string;
  label: string;
  amountCents: number;
  detail: string;
}
export interface Quote {
  band: string;
  bandLabel: string;
  actualGrams: number;
  volumetricGrams: number;
  chargeableGrams: number;
  roundedGrams: number;
  freightCents: number;
  lines: QuoteLine[];
  totalCents: number;
}

export class PricingError extends Error {}

export function volumetricGrams(l: number, w: number, h: number, divisor: number): number {
  if (l <= 0 || w <= 0 || h <= 0) return 0;
  // cm³ ÷ divisor = kg; × 1000 = g. Integer ceil: (a + b − 1) ÷ b.
  const cm3 = l * w * h;
  return Math.floor((cm3 * 1000 + divisor - 1) / divisor);
}

export function roundUp(grams: number, step: number): number {
  return Math.ceil(grams / step) * step;
}

/** Half-up basis points of an integer cent amount. */
export function basisPoints(cents: number, bp: number): number {
  return Math.floor((cents * bp + 5000) / 10_000);
}

export function quote(
  version: PricingVersion,
  bands: PricingBand[],
  slabs: PricingSlab[],
  surcharges: PricingSurcharge[],
  input: QuoteInput,
): Quote {
  if (!Number.isInteger(input.weightGrams) || input.weightGrams <= 0) {
    throw new PricingError("Weight must be a whole number of grams above zero.");
  }
  const band = bands.find((b) => b.band === input.band);
  if (!band) throw new PricingError(`This tariff has no "${input.band}" band.`);
  const bandSlabs = slabs.filter((s) => s.band === input.band).sort((a, z) => a.maxGrams - z.maxGrams);
  if (bandSlabs.length === 0) throw new PricingError(`Band "${input.band}" has no weight slabs.`);

  const vol =
    input.lengthCm && input.widthCm && input.heightCm
      ? volumetricGrams(input.lengthCm, input.widthCm, input.heightCm, version.volumetricDivisor)
      : 0;
  const chargeable = Math.max(input.weightGrams, vol);
  const rounded = roundUp(chargeable, version.roundingGrams);

  const lines: QuoteLine[] = [];
  const hit = bandSlabs.find((s) => s.maxGrams >= rounded);
  let freight: number;
  if (hit) {
    freight = hit.priceCents;
    lines.push({
      code: "freight",
      label: `Freight — ${band.label}`,
      amountCents: freight,
      detail: `${rounded} g falls in the up-to-${hit.maxGrams} g slab`,
    });
  } else {
    const top = bandSlabs[bandSlabs.length - 1]!;
    const extraKg = Math.ceil((rounded - top.maxGrams) / 1000);
    freight = top.priceCents + extraKg * band.extraPerKgCents;
    lines.push({
      code: "freight",
      label: `Freight — ${band.label}`,
      amountCents: freight,
      detail: `up-to-${top.maxGrams} g slab + ${extraKg} started kg × ${band.extraPerKgCents} cents`,
    });
  }

  const requested = new Set(input.requested ?? []);
  for (const code of requested) {
    const s = surcharges.find((x) => x.code === code);
    if (!s) throw new PricingError(`Unknown surcharge "${code}".`);
    if (s.mode !== "on_request") throw new PricingError(`Surcharge "${code}" always applies; it cannot be requested.`);
  }
  for (const s of surcharges) {
    if (s.mode === "on_request" && !requested.has(s.code)) continue;
    const amountCents = s.kind === "flat" ? s.amount : basisPoints(freight, s.amount);
    lines.push({
      code: s.code,
      label: s.label,
      amountCents,
      detail: s.kind === "flat" ? "flat" : `${(s.amount / 100).toFixed(2)}% of freight`,
    });
  }

  return {
    band: band.band,
    bandLabel: band.label,
    actualGrams: input.weightGrams,
    volumetricGrams: vol,
    chargeableGrams: chargeable,
    roundedGrams: rounded,
    freightCents: freight,
    lines,
    totalCents: lines.reduce((sum, l) => sum + l.amountCents, 0),
  };
}

/** Why a draft cannot be published, or [] when it can. */
export function tariffProblems(
  version: PricingVersion,
  bands: PricingBand[],
  slabs: PricingSlab[],
  surcharges: PricingSurcharge[],
): string[] {
  const out: string[] = [];
  if (!Number.isInteger(version.volumetricDivisor) || version.volumetricDivisor < 1000 || version.volumetricDivisor > 10_000) {
    out.push("Volumetric divisor must be a whole number between 1000 and 10000 cm³/kg.");
  }
  if (!Number.isInteger(version.roundingGrams) || version.roundingGrams < 1 || version.roundingGrams > 5000) {
    out.push("Rounding step must be between 1 and 5000 g.");
  }
  if (bands.length === 0) out.push("A tariff needs at least one band.");
  const seenBands = new Set<string>();
  for (const b of bands) {
    if (seenBands.has(b.band)) out.push(`Band "${b.band}" appears twice.`);
    seenBands.add(b.band);
    if (!Number.isInteger(b.extraPerKgCents) || b.extraPerKgCents < 0) out.push(`Band "${b.band}": per-kg overflow must be ≥ 0 cents.`);
    const own = slabs.filter((s) => s.band === b.band).sort((a, z) => a.maxGrams - z.maxGrams);
    if (own.length === 0) out.push(`Band "${b.band}" has no weight slabs.`);
    for (let i = 0; i < own.length; i++) {
      const s = own[i]!;
      if (!Number.isInteger(s.maxGrams) || s.maxGrams <= 0) out.push(`Band "${b.band}": slab weights must be whole grams above zero.`);
      if (!Number.isInteger(s.priceCents) || s.priceCents < 0) out.push(`Band "${b.band}": slab prices must be ≥ 0 cents.`);
      if (i > 0 && s.maxGrams === own[i - 1]!.maxGrams) out.push(`Band "${b.band}": two slabs end at ${s.maxGrams} g.`);
      if (i > 0 && s.priceCents < own[i - 1]!.priceCents) {
        out.push(`Band "${b.band}": the up-to-${s.maxGrams} g slab costs less than the lighter slab before it.`);
      }
    }
  }
  for (const s of slabs) if (!seenBands.has(s.band)) out.push(`A slab refers to unknown band "${s.band}".`);
  const seenSur = new Set<string>();
  for (const s of surcharges) {
    if (seenSur.has(s.code)) out.push(`Surcharge "${s.code}" appears twice.`);
    seenSur.add(s.code);
    if (s.code === "freight") out.push(`"freight" is reserved and cannot be a surcharge code.`);
    if (!Number.isInteger(s.amount) || s.amount < 0) out.push(`Surcharge "${s.code}": amount must be a whole number ≥ 0.`);
    if (s.kind === "percent" && s.amount > 10_000) out.push(`Surcharge "${s.code}": a percentage above 100% is refused.`);
  }
  return out;
}
