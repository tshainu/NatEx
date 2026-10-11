import type { TariffDocument } from "./rate-cards";
import {
  DEFAULT_VOLUMETRIC_DIVISOR_CM3_PER_KG,
  DEFAULT_WEIGHT_ROUNDING_GRAMS,
  MAX_ACCEPTED_WEIGHT_GRAMS,
} from "./pricing";

export const NATEX_STANDARD_CARD_CODE = "NATEX-STANDARD-2026";
export const NATEX_STANDARD_CARD_NAME = "NatEx Standard Tariff 2026";
export const NATEX_STANDARD_APPROVAL_NOTE =
  "Owner-confirmed 2026-10-11: Rs 400 up to 1 kg; add Rs 250 per started extra kg above 1 through 3 kg, Rs 150 per started extra kg above 3 through 10 kg, and Rs 130 per started extra kg above 10 through 30 kg. The supplied amounts are identical for local/outstation and COD/non-COD. Existing 500 g rounding and 5,000 cm³/kg volumetric divisor are retained; maximum chargeable weight is 30 kg; no surcharge was specified. COD collection/remittance remains separate from courier freight.";

const MAX_WHOLE_KG = MAX_ACCEPTED_WEIGHT_GRAMS / 1000;

/** Return the progressive freight amount in cents for an exact whole kg. */
export function natexStandardPriceCentsForKg(kg: number): number {
  if (!Number.isSafeInteger(kg) || kg < 1 || kg > MAX_WHOLE_KG) {
    throw new RangeError(`Standard tariff weight must be a whole kilogram from 1 to ${MAX_WHOLE_KG}.`);
  }
  let rupees = 400;
  for (let startedExtraKg = 2; startedExtraKg <= kg; startedExtraKg += 1) {
    rupees += startedExtraKg <= 3 ? 250 : startedExtraKg <= 10 ? 150 : 130;
  }
  return rupees * 100;
}

/**
 * Database-ready, single-price-class tariff. All four user-supplied price
 * categories are equal, so local/outstation share the same schedule and there
 * is no COD-vs-freight accounting coupling.
 */
export function natexStandardTariffDocument(): TariffDocument {
  const bands: TariffDocument["bands"] = [
    { band: "local", label: "Same district", extraPerKgCents: 0 },
    { band: "outstation", label: "Different district", extraPerKgCents: 0 },
  ];
  const slabs: TariffDocument["slabs"] = bands.flatMap(({ band }) =>
    Array.from({ length: MAX_WHOLE_KG }, (_, index) => {
      const kg = index + 1;
      return {
        band,
        maxGrams: kg * 1000,
        priceCents: natexStandardPriceCentsForKg(kg),
      };
    }),
  );

  return {
    volumetricDivisor: DEFAULT_VOLUMETRIC_DIVISOR_CM3_PER_KG,
    roundingGrams: DEFAULT_WEIGHT_ROUNDING_GRAMS,
    note: NATEX_STANDARD_APPROVAL_NOTE,
    bands,
    slabs,
    surcharges: [],
  };
}
