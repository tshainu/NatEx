/**
 * Finance configuration — every number the money module needs, as data.
 *
 * Nothing here is a hardcoded constant in a code path. The client's answers of
 * 2026-09-30 (resolving PROJECT.md §15 q3, q4, q5, q9 and part of q10) are
 * seeded rows that M5's admin portal can change without a deploy, because most
 * of them are explicitly temporary:
 *
 *   - COD fee is zero because "COD handling is bundled into the delivery rate"
 *   - RTO fee is zero "for promotion purpose" for the first few months, and the
 *     client asked specifically to "have option to alter RTO fee"
 *   - VAT and SSCL are OFF, pending NatEx's registration status
 *
 * §15 q10 REMAINS AN OPEN QUESTION, NOT A DECISION. The tax arithmetic is
 * implemented and correct (SSCL on the charge, then VAT on charge + SSCL — the
 * Sri Lankan stacking order) but computes to zero while the flags are off.
 * Rates below are the real current LK rates so that turning them on is a
 * config change and not a research project: VAT 18% (standard rate since
 * 2024-01-01), SSCL 2.5% on liable turnover.
 *
 * Percentages are stored as basis points (1% = 100 bp) so no rate is ever a
 * float — §9: "Never use float or double for money."
 */

import { db } from "../../database";
import { codFinanceConfig } from "../../database/schema/cod";

export const CONFIG_KEYS = {
  /** §15 q3 — bundled into the delivery rate, so zero. Alterable. */
  COD_FEE_FLAT_CENTS: "cod_fee_flat_cents",
  /** Percentage-of-COD alternative to the flat fee. Also zero today. */
  COD_FEE_BP: "cod_fee_bp",
  /** §8 deduction — zero for the promo period, at the client's request. */
  RTO_FEE_CENTS: "rto_fee_cents",
  /** §8 deduction — charged when a reweigh disagrees with the declared weight. */
  WEIGHT_DISCREPANCY_FEE_CENTS: "weight_discrepancy_fee_cents",
  /** §8 deduction — onward carriage to an out-of-network address. */
  FORWARDING_FEE_CENTS: "forwarding_fee_cents",

  /** §15 q10 — OFF. Turning this on starts charging VAT on freight invoices. */
  VAT_ACTIVE: "vat_active",
  VAT_BP: "vat_bp",
  /** §15 q10 — OFF. SSCL is levied on turnover, and stacks under VAT. */
  SSCL_ACTIVE: "sscl_active",
  SSCL_BP: "sscl_bp",
  /** Not modelled as active: no WHT deduction today (§8 lists it, client declined). */
  WHT_ACTIVE: "wht_active",
  WHT_BP: "wht_bp",

  /** §8 control — "Rider exceeds configurable limit → further dispatch blocked". */
  RIDER_CASH_CEILING_CENTS: "rider_cash_ceiling_cents",
  /** §8 control — "Collected > 48 h without deposit → escalate to ops". */
  STALE_COLLECTION_HOURS: "stale_collection_hours",

  /** §15 q4 — weekly cycle. 5 = Friday, ISO weekday numbering. */
  SETTLEMENT_CUTOFF_WEEKDAY: "settlement_cutoff_weekday",
  /** Days from the Friday cut-off to the payout. 5 → the following Wednesday. */
  SETTLEMENT_PAYOUT_LAG_DAYS: "settlement_payout_lag_days",
  /** §15 q5 — Net 14 for merchant freight invoices. */
  INVOICE_DUE_DAYS: "invoice_due_days",

  /** §8 — disputes and loss/damage claims: days finance has to resolve a case. */
  DISPUTE_SLA_DAYS: "dispute_sla_days",
} as const;

export type ConfigKey = (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS];

type Seed = {
  key: ConfigKey;
  value: number;
  unit: "cents" | "basis_points" | "hours" | "days" | "boolean" | "count";
  description: string;
  note: string;
};

/**
 * The seeded defaults. `value` is what the client chose; `note` records WHY,
 * because a future reader finding a zero fee needs to know whether it is a
 * promotion or a bug.
 */
export const CONFIG_SEED: Seed[] = [
  {
    key: CONFIG_KEYS.COD_FEE_FLAT_CENTS,
    value: 0,
    unit: "cents",
    description: "Flat COD handling fee deducted per delivered COD parcel",
    note: "Client 2026-09-30 (§15 q3): COD handling is bundled into the delivery rate. Zero by decision, not by omission.",
  },
  {
    key: CONFIG_KEYS.COD_FEE_BP,
    value: 0,
    unit: "basis_points",
    description: "COD fee as a percentage of the collected amount (alternative to the flat fee)",
    note: "Unused while the flat fee model is in force. Both being zero is the intended state.",
  },
  {
    key: CONFIG_KEYS.RTO_FEE_CENTS,
    value: 0,
    unit: "cents",
    description: "Return-to-origin fee deducted when a parcel comes back undelivered",
    note: "Client 2026-09-30: \"at first few month we do not charge for RTO for promotion purpose so have option to alter RTO fee\". PROMOTIONAL AND TIME-LIMITED — revisit, do not treat as permanent.",
  },
  {
    key: CONFIG_KEYS.WEIGHT_DISCREPANCY_FEE_CENTS,
    value: 25_000,
    unit: "cents",
    description: "Fee deducted when a reweigh disagrees with the merchant's declared weight",
    note: "Active per the client's answer on §8 deductions. Rs. 250.00.",
  },
  {
    key: CONFIG_KEYS.FORWARDING_FEE_CENTS,
    value: 0,
    unit: "cents",
    description: "Onward carriage fee for an address outside the delivery network",
    note: "Modelled per §8 but not switched on; no forwarding partner rates agreed yet.",
  },

  {
    key: CONFIG_KEYS.VAT_ACTIVE,
    value: 0,
    unit: "boolean",
    description: "Whether VAT is charged on freight invoices",
    note: "OFF. §15 q10 IS STILL OPEN: awaiting confirmation of NatEx's VAT registration status. The arithmetic is implemented and tested; only the flag is off.",
  },
  {
    key: CONFIG_KEYS.VAT_BP,
    value: 1_800,
    unit: "basis_points",
    description: "VAT rate",
    note: "18% — Sri Lanka's standard rate since 2024-01-01. Correct rate held ready so enabling VAT is a config change.",
  },
  {
    key: CONFIG_KEYS.SSCL_ACTIVE,
    value: 0,
    unit: "boolean",
    description: "Whether SSCL is charged on freight invoices",
    note: "OFF, same open question as VAT (§15 q10).",
  },
  {
    key: CONFIG_KEYS.SSCL_BP,
    value: 250,
    unit: "basis_points",
    description: "Social Security Contribution Levy rate on liable turnover",
    note: "2.5%. SSCL is levied before VAT and VAT applies to charge + SSCL (§9: VAT plus SSCL, never Indian GST).",
  },
  {
    key: CONFIG_KEYS.WHT_ACTIVE,
    value: 0,
    unit: "boolean",
    description: "Whether withholding tax is deducted from merchant settlements",
    note: "OFF. §8 lists WHT among the deductions; the client chose not to model it as active. LK rate is 5% on resident service fees above Rs. 100,000/month if it is ever needed.",
  },
  {
    key: CONFIG_KEYS.WHT_BP,
    value: 500,
    unit: "basis_points",
    description: "Withholding tax rate",
    note: "5%, held ready but inactive.",
  },

  {
    key: CONFIG_KEYS.RIDER_CASH_CEILING_CENTS,
    value: 5_000_000,
    unit: "cents",
    description: "Cash a rider may hold before further dispatch is blocked",
    note: "Client 2026-09-30 (§15 q9): Rs. 50,000. §8 control — over the ceiling, dispatch is blocked and ops are notified.",
  },
  {
    key: CONFIG_KEYS.STALE_COLLECTION_HOURS,
    value: 48,
    unit: "hours",
    description: "Hours a collection may go undeposited before it escalates to ops",
    note: "§8 control, verbatim: \"Collected > 48 h without deposit → escalate to ops\".",
  },

  {
    key: CONFIG_KEYS.SETTLEMENT_CUTOFF_WEEKDAY,
    value: 5,
    unit: "count",
    description: "ISO weekday the settlement period closes on (1 = Monday)",
    note: "Client 2026-09-30 (§15 q4): weekly cycle with a Friday cut-off.",
  },
  {
    key: CONFIG_KEYS.SETTLEMENT_PAYOUT_LAG_DAYS,
    value: 5,
    unit: "days",
    description: "Days from the period cut-off to the payout date",
    note: "Friday cut-off + 5 days = the following Wednesday, per the client's answer.",
  },
  {
    key: CONFIG_KEYS.INVOICE_DUE_DAYS,
    value: 14,
    unit: "days",
    description: "Credit term on merchant freight invoices",
    note: "Client 2026-09-30 (§15 q5): Net 14, ageing buckets 0-30/31-60/61-90/90+, no hard credit limit.",
  },
  {
    key: CONFIG_KEYS.DISPUTE_SLA_DAYS,
    value: 5,
    unit: "days",
    description: "Days finance has to resolve a merchant dispute or loss/damage claim",
    note: "Not specified in PROJECT.md; 5 working-day default chosen so overdue cases surface. Alterable (§15 open — confirm with client).",
  },
];

/** Defaults by key, for reads that happen before the table is seeded. */
const DEFAULTS: Record<string, number> = Object.fromEntries(
  CONFIG_SEED.map((s) => [s.key, s.value]),
);

/**
 * Cached because the ledger reads the ceiling on every dispatch check. Cleared
 * whenever a value is written, so the finance portal's edit takes effect at
 * once rather than after a restart.
 */
let cache: Map<string, number> | null = null;

export function clearConfigCache(): void {
  cache = null;
}

async function load(): Promise<Map<string, number>> {
  if (cache) return cache;
  const rows = await db.select().from(codFinanceConfig);
  const map = new Map<string, number>();
  for (const [key, value] of Object.entries(DEFAULTS)) map.set(key, value);
  for (const row of rows) map.set(row.key, row.value);
  cache = map;
  return map;
}

/** A configured integer. Falls back to the seeded default if the row is missing. */
export async function configValue(key: ConfigKey): Promise<number> {
  const map = await load();
  return map.get(key) ?? DEFAULTS[key] ?? 0;
}

/** A configured boolean flag. */
export async function configFlag(key: ConfigKey): Promise<boolean> {
  return (await configValue(key)) === 1;
}

/** Every value at once, for the finance dashboard and the settlement engine. */
export async function financeConfig(): Promise<Record<ConfigKey, number>> {
  const map = await load();
  const out = {} as Record<ConfigKey, number>;
  for (const seed of CONFIG_SEED) out[seed.key] = map.get(seed.key) ?? seed.value;
  return out;
}

/**
 * Write the config table's defaults. Idempotent: an operator's edit survives
 * a re-seed, because only missing keys are inserted.
 */
export async function seedFinanceConfig(): Promise<{ inserted: number }> {
  const existing = await db.select({ key: codFinanceConfig.key }).from(codFinanceConfig);
  const have = new Set(existing.map((r) => r.key));
  const missing = CONFIG_SEED.filter((s) => !have.has(s.key));
  if (missing.length) {
    await db.insert(codFinanceConfig).values(
      missing.map((s) => ({
        key: s.key,
        value: s.value,
        unit: s.unit,
        description: s.description,
        note: s.note,
        updatedAt: new Date(),
        updatedByName: "seed",
      })),
    );
  }
  clearConfigCache();
  return { inserted: missing.length };
}

/**
 * Change one value. This is the path the client's "option to alter RTO fee"
 * requires, and the reason none of these numbers are constants.
 */
export async function setConfigValue(input: {
  key: ConfigKey;
  value: number;
  note?: string;
  actorName?: string;
}): Promise<void> {
  if (!Number.isInteger(input.value)) {
    throw new Error(`config ${input.key} must be an integer, got ${input.value}`);
  }
  // Upsert: an unseeded database must not swallow an edit as a 0-row UPDATE.
  const seed = CONFIG_SEED.find((s) => s.key === input.key)!;
  await db
    .insert(codFinanceConfig)
    .values({
      key: input.key,
      value: input.value,
      unit: seed.unit,
      description: seed.description,
      note: input.note ?? seed.note,
      updatedAt: new Date(),
      updatedByName: input.actorName ?? null,
    })
    .onConflictDoUpdate({
      target: codFinanceConfig.key,
      set: {
        value: input.value,
        note: input.note,
        updatedAt: new Date(),
        updatedByName: input.actorName ?? null,
      },
    });
  clearConfigCache();
}

/**
 * Every config row as finance sees it: value, unit, why it is what it is, and
 * who last changed it. Missing rows are reported with their seeded default so
 * the screen never shows a hole.
 */
export async function listConfig(): Promise<
  {
    key: ConfigKey;
    value: number;
    unit: Seed["unit"];
    description: string;
    note: string | null;
    updatedAt: Date | null;
    updatedByName: string | null;
  }[]
> {
  const rows = await db.select().from(codFinanceConfig);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return CONFIG_SEED.map((s) => {
    const row = byKey.get(s.key);
    return {
      key: s.key,
      value: row?.value ?? s.value,
      unit: s.unit,
      description: s.description,
      note: row?.note ?? s.note,
      updatedAt: row?.updatedAt ?? null,
      updatedByName: row?.updatedByName ?? null,
    };
  });
}

/** The unit a key is measured in, for validating an edit. */
export function unitOf(key: ConfigKey): Seed["unit"] {
  return CONFIG_SEED.find((s) => s.key === key)!.unit;
}

/**
 * Range rule per unit. Returns the reason a value is refused, or null.
 * Integer-only throughout (§9): cents, basis points, hours, days, counts.
 */
export function configValueProblem(key: ConfigKey, value: number): string | null {
  if (!Number.isInteger(value)) return "Must be a whole number.";
  if (value < 0) return "Cannot be negative.";
  const unit = unitOf(key);
  if (unit === "boolean" && value !== 0 && value !== 1) return "A switch is 0 (off) or 1 (on).";
  if (unit === "basis_points" && value > 10_000) return "Basis points run 0–10,000 (0–100%).";
  if (key === CONFIG_KEYS.SETTLEMENT_CUTOFF_WEEKDAY && (value < 1 || value > 7)) {
    return "ISO weekday: 1 (Monday) to 7 (Sunday).";
  }
  return null;
}

// ───────────────────────────────────────────────────────────── tax arithmetic

/**
 * SSCL then VAT on a service charge, in the Sri Lankan stacking order.
 *
 * Returns zeros while the flags are off, which is today's state — but the
 * arithmetic is real, so switching the flags on produces correct invoices
 * without touching this code. Rounding is to whole cents at each step (§9).
 */
export function taxOn(
  chargeCents: number,
  rates: { vatActive: boolean; vatBp: number; ssclActive: boolean; ssclBp: number },
): { ssclCents: number; vatCents: number; grossCents: number } {
  const sscl = rates.ssclActive ? Math.round((chargeCents * rates.ssclBp) / 10_000) : 0;
  // VAT applies to the charge INCLUSIVE of SSCL — the levy is part of the
  // taxable value, not a separate line outside it.
  const vat = rates.vatActive ? Math.round(((chargeCents + sscl) * rates.vatBp) / 10_000) : 0;
  return { ssclCents: sscl, vatCents: vat, grossCents: chargeCents + sscl + vat };
}

/** Tax on a charge, reading the live config. */
export async function taxOnCharge(chargeCents: number) {
  const cfg = await financeConfig();
  return taxOn(chargeCents, {
    vatActive: cfg[CONFIG_KEYS.VAT_ACTIVE] === 1,
    vatBp: cfg[CONFIG_KEYS.VAT_BP],
    ssclActive: cfg[CONFIG_KEYS.SSCL_ACTIVE] === 1,
    ssclBp: cfg[CONFIG_KEYS.SSCL_BP],
  });
}
