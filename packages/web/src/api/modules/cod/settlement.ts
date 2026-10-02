/**
 * Merchant settlement — §8 checkpoints 4 and 5.
 *
 *   "4 · Finance runs merchant settlement   settlement + settlement_lines"
 *   "5 · Payout executed, UTR recorded, remittance advice sent"
 *
 * Four rules from §8 shape every function here:
 *
 *   1. A run is a PROPOSAL until approved, and "the creator cannot approve
 *      their own run". `approveSettlement()` refuses the maker, by user id,
 *      and the refusal is not configurable.
 *   2. Deductions are modelled EXPLICITLY — one line per charge, each naming
 *      its parcel where it has one. A waived charge still gets a line, at zero,
 *      so a merchant can see it was considered rather than forgotten.
 *   3. Any open variance blocks the payout. Holds are read from `cod_hold`
 *      (see `holds.ts`); a held parcel is left out of the run and a
 *      merchant-scoped hold stops the run moving at all.
 *   4. The header never drifts from its lines. gross/deductions/net are
 *      derived from the lines and re-asserted on every read that matters.
 *
 * WHAT THE MERCHANT IS OWED comes from ACCRUE entries, posted per parcel when
 * a branch banks the cash. Settling against banked cash rather than collected
 * cash is deliberate: money still in a rider's pocket is not NatEx's to pay
 * out, and §8's four-way reconciliation exists precisely to keep those stages
 * apart.
 *
 * CYCLE: weekly, Friday cut-off, payout the following Wednesday — the client's
 * answer to §15 q4. Both live in `cod_finance_config`, so a change of cycle is
 * a config edit; and each run stores the dates it used, so changing the cycle
 * never restates history.
 *
 * TAX IS INACTIVE. §15 q10 ("Invoice format and VAT/SSCL treatment for COD
 * fees?") is STILL AN OPEN QUESTION, not a decision. Withholding tax is
 * modelled and computed, and seeded off. THIS IS FLAGGED, NOT SETTLED.
 */

import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../database";
import {
  codEntry,
  codHold,
  codMerchantPayout,
  codSettlement,
  codSettlementLine,
} from "../../database/schema/cod";
import { errors, fail, problem } from "../../shared/errors";
import { formatLkr } from "../../shared/money";
import { enqueue } from "../../shared/outbox";
import { writeAudit } from "../../shared/audit";
import { prefixedId } from "../../shared/ulid";
import { insertWithFreshCode, mintDocumentCode } from "../../shared/codes";
import {
  addDays,
  colomboToday,
  formatLkDate,
  lastWeekdayOnOrBefore,
} from "../../shared/time";
import type { Principal } from "../../shared/auth";
import { getMerchant } from "../merchants/service";
import { rtosForBilling } from "../delivery/ndr";
import { ACCOUNTS, balances, liveEntries, merchantPayable } from "./accounts";
import { CONFIG_KEYS, configFlag, configValue } from "./config";
import { merchantHoldState, type CodHoldRow } from "./holds";
import { appendLedgerEntry } from "./service";

export type SettlementRow = typeof codSettlement.$inferSelect;
export type SettlementLineRow = typeof codSettlementLine.$inferSelect;
export type MerchantPayoutRow = typeof codMerchantPayout.$inferSelect;

/** §8: "Deductions modelled explicitly: COD fee, forwarding, RTO fee, weight discrepancy, penalties, withholding tax." */
export const SETTLEMENT_LINE_TYPES = [
  /** Positive. COD banked on the merchant's behalf, one line per parcel. */
  "cod_collected",
  "cod_fee",
  "rto_fee",
  "forwarding",
  "weight_discrepancy",
  "penalty",
  "withholding_tax",
  /** Anything finance has to add by hand, with a reason. */
  "adjustment",
] as const;
export type SettlementLineType = (typeof SETTLEMENT_LINE_TYPES)[number];

/** The deduction types a caller may supply by hand on a run. */
export const MANUAL_DEDUCTION_TYPES = [
  "forwarding",
  "weight_discrepancy",
  "penalty",
  "adjustment",
] as const;
export type ManualDeductionType = (typeof MANUAL_DEDUCTION_TYPES)[number];

export interface ManualDeduction {
  type: ManualDeductionType;
  /**
   * Positive cents to deduct. Omitted, the configured rate for that type is
   * used (weight discrepancy and forwarding have one; a penalty does not).
   */
  amountCents?: number;
  parcelId?: string | null;
  awb?: string | null;
  description: string;
}

// ────────────────────────────────────────────────────────────── the cycle

export interface SettlementPeriod {
  periodStart: string;
  periodEnd: string;
  payoutDate: string;
  cutoffWeekday: number;
  payoutLagDays: number;
}

/**
 * The seven-day period ending on `cutoff`, and when its payout is due.
 *
 * Pure, so the cycle can be tested without a database: §16's "prove it runs"
 * is cheaper to honour when the arithmetic is separable from the config read.
 */
export function periodEndingOn(
  cutoff: string,
  cutoffWeekday: number,
  payoutLagDays: number,
): SettlementPeriod {
  return {
    periodStart: addDays(cutoff, -6),
    periodEnd: cutoff,
    payoutDate: addDays(cutoff, payoutLagDays),
    cutoffWeekday,
    payoutLagDays,
  };
}

/**
 * The most recent completed period as of `asOf` (default: today, Asia/Colombo).
 *
 * "Completed" means the cut-off has passed: run on a Friday, the week that
 * ends that same Friday is settled; run on a Tuesday, last Friday's week is.
 */
export async function currentPeriod(asOf?: string): Promise<SettlementPeriod> {
  const cutoffWeekday = await configValue(CONFIG_KEYS.SETTLEMENT_CUTOFF_WEEKDAY);
  const lag = await configValue(CONFIG_KEYS.SETTLEMENT_PAYOUT_LAG_DAYS);
  const today = asOf ?? colomboToday();
  return periodEndingOn(lastWeekdayOnOrBefore(today, cutoffWeekday), cutoffWeekday, lag);
}

function mintSettlementCode(periodEnd: string): string {
  return mintDocumentCode("STL", periodEnd);
}

// ──────────────────────────────────────────────────── where the money goes

export async function getMerchantPayout(merchantId: string): Promise<MerchantPayoutRow | null> {
  const [row] = await db
    .select()
    .from(codMerchantPayout)
    .where(eq(codMerchantPayout.merchantId, merchantId));
  return row ?? null;
}

/**
 * Record or correct a merchant's bank beneficiary details.
 *
 * Audited with the account number partially masked: an audit trail that anyone
 * with read access can mine for full account numbers is a liability, and the
 * current value is one query away for someone who is allowed to see it.
 */
export async function setMerchantPayout(input: {
  merchantId: string;
  beneficiaryName: string;
  bankName: string;
  branchName: string;
  accountNumber: string;
  verified?: boolean;
  note?: string | null;
  actor?: Principal | null;
}): Promise<MerchantPayoutRow> {
  for (const [field, value] of Object.entries({
    beneficiaryName: input.beneficiaryName,
    bankName: input.bankName,
    branchName: input.branchName,
    accountNumber: input.accountNumber,
  })) {
    if (!value?.trim()) {
      fail(
        "BAD_REQUEST",
        problem(
          "payout-details-incomplete",
          "Payout details incomplete",
          422,
          `The payout file needs ${field} for every merchant it pays.`,
          { field },
        ),
      );
    }
  }

  const before = await getMerchantPayout(input.merchantId);
  const values = {
    merchantId: input.merchantId,
    beneficiaryName: input.beneficiaryName.trim(),
    bankName: input.bankName.trim(),
    branchName: input.branchName.trim(),
    accountNumber: input.accountNumber.trim(),
    // Re-entered details are unverified again until someone checks them: the
    // point of the flag is that a human compared them to a bank document.
    verified: input.verified ?? false,
    note: input.note ?? null,
    updatedAt: new Date(),
    updatedByName: input.actor?.name ?? null,
  };

  if (before) {
    await db
      .update(codMerchantPayout)
      .set(values)
      .where(eq(codMerchantPayout.merchantId, input.merchantId));
  } else {
    await db.insert(codMerchantPayout).values(values);
  }

  await writeAudit({
    entity: "cod_merchant_payout",
    entityId: input.merchantId,
    action: "cod.payout_details_set",
    actor: input.actor,
    before: before ? { bankName: before.bankName, account: mask(before.accountNumber) } : null,
    after: { bankName: values.bankName, account: mask(values.accountNumber) },
  });

  return (await getMerchantPayout(input.merchantId))!;
}

function mask(account: string): string {
  return account.length <= 4 ? "****" : `****${account.slice(-4)}`;
}

// ───────────────────────────────────────────────── what a run would contain

export interface DraftLine {
  type: SettlementLineType;
  parcelId: string | null;
  awb: string | null;
  /** SIGNED: positive credits the merchant, negative deducts. */
  amountCents: number;
  description: string;
  entryId: string | null;
}

export interface SettlementPreview {
  merchantId: string;
  merchantName: string;
  period: SettlementPeriod;
  lines: DraftLine[];
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  /** Parcels left out because something is unexplained (§8 controls). */
  heldParcels: { parcelId: string; awb: string | null; amountCents: number; reason: string }[];
  /** Merchant-wide holds. Non-empty means the run cannot be paid. */
  blockingHolds: CodHoldRow[];
  /** What the ledger says is still owed, independent of these lines. */
  payableCents: number;
  /** Open questions and waivers a finance user should see on the screen. */
  notes: string[];
}

/**
 * Entry ids already claimed by a settlement that has not been rejected.
 *
 * The guard against paying the same parcel twice is this, not the period
 * boundaries: a rejected run releases its money, an approved or even merely
 * drafted one does not.
 */
async function claimedEntryIds(): Promise<Set<string>> {
  const rows = await db
    .select({ entryId: codSettlementLine.entryId })
    .from(codSettlementLine)
    .innerJoin(codSettlement, eq(codSettlementLine.settlementId, codSettlement.id))
    .where(ne(codSettlement.status, "rejected"));
  const out = new Set<string>();
  for (const row of rows) if (row.entryId) out.add(row.entryId);
  return out;
}

/**
 * Build the lines a run would carry, without writing anything.
 *
 * Used by the finance portal's preview and by `createSettlement()` itself, so
 * what a user approves is computed by the same code that showed it to them.
 */
export async function settlementPreview(input: {
  merchantId: string;
  period?: SettlementPeriod;
  deductions?: ManualDeduction[];
  asOf?: string;
}): Promise<SettlementPreview> {
  const merchant = await getMerchant(input.merchantId);
  if (!merchant) errors.notFound("Merchant");
  const period = input.period ?? (await currentPeriod(input.asOf));

  const [holds, claimed] = await Promise.all([
    merchantHoldState(input.merchantId),
    claimedEntryIds(),
  ]);

  // The merchant's accruals: one per parcel, posted when their cash was banked.
  const accruals = await db
    .select()
    .from(codEntry)
    .where(
      and(
        eq(codEntry.merchantId, input.merchantId),
        eq(codEntry.type, "ACCRUE"),
        isNull(codEntry.reversedById),
      ),
    )
    .orderBy(asc(codEntry.seq));

  const lines: DraftLine[] = [];
  const heldParcels: SettlementPreview["heldParcels"] = [];
  const notes: string[] = [];

  const codFeeFlat = await configValue(CONFIG_KEYS.COD_FEE_FLAT_CENTS);
  const codFeeBp = await configValue(CONFIG_KEYS.COD_FEE_BP);
  let codFeeTotal = 0;
  let inPeriod = 0;

  for (const entry of accruals) {
    const day = colomboToday(entry.ts);
    if (day < period.periodStart || day > period.periodEnd) continue;
    if (claimed.has(entry.id)) continue;
    inPeriod += 1;

    if (entry.parcelId && holds.heldParcelIds.has(entry.parcelId)) {
      const hold = holds.open.find((h) => h.parcelId === entry.parcelId);
      heldParcels.push({
        parcelId: entry.parcelId,
        awb: entry.awb,
        amountCents: entry.amountCents,
        reason: hold?.detail ?? "Open hold",
      });
      continue;
    }

    lines.push({
      type: "cod_collected",
      parcelId: entry.parcelId,
      awb: entry.awb,
      amountCents: entry.amountCents,
      description: `COD collected on ${entry.awb ?? "parcel"}`,
      entryId: entry.id,
    });

    // §15 q3 — the COD fee is bundled into the delivery rate today, so this is
    // zero. Computed rather than skipped, because switching it on must be a
    // config change and nothing more.
    const fee = codFeeFlat + Math.round((entry.amountCents * codFeeBp) / 10_000);
    if (fee > 0) {
      codFeeTotal += fee;
      lines.push({
        type: "cod_fee",
        parcelId: entry.parcelId,
        awb: entry.awb,
        amountCents: -fee,
        description: `COD fee on ${entry.awb ?? "parcel"}`,
        entryId: null,
      });
    }
  }

  if (codFeeTotal === 0 && inPeriod > 0) {
    // One zero line rather than one per parcel: the waiver is a single fact
    // about the rate card, and a merchant reading their remittance advice
    // should see it stated once.
    lines.push({
      type: "cod_fee",
      parcelId: null,
      awb: null,
      amountCents: 0,
      description: "COD fee waived — bundled into the delivery rate (§15 q3)",
      entryId: null,
    });
  }

  // §8 deduction — RTO fee. Zero for the promotional period at the client's
  // request, and alterable from config without a deploy. Each return is still
  // named on its own line so the waiver is visible parcel by parcel.
  const rtoFee = await configValue(CONFIG_KEYS.RTO_FEE_CENTS);
  const rtos = await rtosForBilling({
    merchantId: input.merchantId,
    from: period.periodStart,
    to: period.periodEnd,
  });
  for (const row of rtos) {
    lines.push({
      type: "rto_fee",
      parcelId: row.parcelId,
      awb: row.awb,
      amountCents: -rtoFee,
      description:
        rtoFee > 0
          ? `RTO fee on ${row.awb} (${row.reason})`
          : `RTO on ${row.awb} — fee waived for the promotional period`,
      entryId: null,
    });
  }
  if (rtos.length > 0 && rtoFee === 0) {
    notes.push(
      `${rtos.length} return(s) in this period carry no RTO fee: waived for the promotional period at the client's request. Set rto_fee_cents to start charging.`,
    );
  }

  // Hand-entered deductions: forwarding, weight discrepancy, penalties and
  // adjustments. Weight discrepancy has no automatic source yet — nothing in
  // the system reweighs a parcel — so it is charged by a finance user against
  // the configured rate.
  const weightFee = await configValue(CONFIG_KEYS.WEIGHT_DISCREPANCY_FEE_CENTS);
  const forwardingFee = await configValue(CONFIG_KEYS.FORWARDING_FEE_CENTS);
  for (const deduction of input.deductions ?? []) {
    const fallback =
      deduction.type === "weight_discrepancy"
        ? weightFee
        : deduction.type === "forwarding"
          ? forwardingFee
          : 0;
    const amount = deduction.amountCents ?? fallback;
    if (!Number.isInteger(amount) || amount < 0) {
      fail(
        "BAD_REQUEST",
        problem(
          "invalid-deduction",
          "Invalid deduction",
          422,
          "A deduction must be a positive whole number of cents; the sign is applied by the settlement, not by the caller.",
          { type: deduction.type, amountCents: deduction.amountCents },
        ),
      );
    }
    if (amount === 0 && deduction.type !== "adjustment") {
      notes.push(
        `${deduction.type} on ${deduction.awb ?? "the account"} has no configured rate and no amount was given — nothing was charged.`,
      );
      continue;
    }
    lines.push({
      type: deduction.type,
      parcelId: deduction.parcelId ?? null,
      awb: deduction.awb ?? null,
      amountCents: -amount,
      description: deduction.description,
      entryId: null,
    });
  }

  // Withholding tax — §8 lists it, and the client has not confirmed NatEx's
  // registration status (§15 q10). Modelled, computed, and OFF.
  const whtActive = await configFlag(CONFIG_KEYS.WHT_ACTIVE);
  const grossSoFar = lines.reduce((sum, line) => sum + Math.max(line.amountCents, 0), 0);
  if (whtActive) {
    const whtBp = await configValue(CONFIG_KEYS.WHT_BP);
    const wht = Math.round((grossSoFar * whtBp) / 10_000);
    if (wht > 0) {
      lines.push({
        type: "withholding_tax",
        parcelId: null,
        awb: null,
        amountCents: -wht,
        description: `Withholding tax at ${(whtBp / 100).toFixed(2)}% on ${formatLkr(grossSoFar)}`,
        entryId: null,
      });
    }
  } else {
    notes.push(
      "No withholding tax, VAT or SSCL is applied. §15 q10 (VAT/SSCL treatment) is an OPEN QUESTION — the arithmetic is implemented and tested but inactive until the client confirms registration.",
    );
  }

  if (holds.blockingHolds.length > 0) {
    notes.push(
      `${holds.blockingHolds.length} merchant-level hold(s) are open. §8: any open variance blocks this merchant's payout.`,
    );
  }
  if (heldParcels.length > 0) {
    notes.push(
      `${heldParcels.length} parcel(s) held from this run pending explanation; they stay eligible for a later period once cleared.`,
    );
  }

  const totals = totalsFor(lines);
  const payableCents = await merchantPayableCents(input.merchantId);

  return {
    merchantId: input.merchantId,
    merchantName: merchant!.name,
    period,
    lines,
    ...totals,
    heldParcels,
    blockingHolds: holds.blockingHolds,
    payableCents,
    notes,
  };
}

/** gross / deductions / net, derived from the lines and nowhere else. */
function totalsFor(lines: readonly { amountCents: number }[]): {
  grossCents: number;
  deductionsCents: number;
  netCents: number;
} {
  let gross = 0;
  let deductions = 0;
  for (const line of lines) {
    if (line.amountCents >= 0) gross += line.amountCents;
    else deductions += -line.amountCents;
  }
  return { grossCents: gross, deductionsCents: deductions, netCents: gross - deductions };
}

/** What the ledger says is still owed to one merchant (ACCRUE − SETTLE/FEE/TAX). */
export async function merchantPayableCents(merchantId: string): Promise<number> {
  const rows = await db.select().from(codEntry).where(eq(codEntry.merchantId, merchantId));
  return merchantPayable(liveEntries(rows));
}

// ─────────────────────────────────────────────────── checkpoint 4 — the run

/**
 * Draft a run. Nothing is paid and no ledger entry is posted: §8 says a
 * settlement "is a proposal until approved", and a proposal that had already
 * moved money would not be one.
 */
export async function createSettlement(input: {
  merchantId: string;
  period?: SettlementPeriod;
  deductions?: ManualDeduction[];
  asOf?: string;
  actor: Principal;
}): Promise<{ settlement: SettlementRow; lines: SettlementLineRow[]; preview: SettlementPreview }> {
  if (!input.actor?.userId) {
    fail(
      "BAD_REQUEST",
      problem(
        "actor-required",
        "Named creator required",
        422,
        "§8's maker–checker rule needs to know who created this run, so an anonymous run is refused.",
      ),
    );
  }

  // The open-run check comes BEFORE the preview is built, and has to. A
  // drafted run claims its accruals, so a second attempt at the same period
  // previews as empty — reporting "nothing to settle" there would send finance
  // hunting for missing collections when the real answer is that a run is
  // already open on the period.
  const merchant = await getMerchant(input.merchantId);
  if (!merchant) errors.notFound("Merchant");
  const wantedPeriod = input.period ?? (await currentPeriod(input.asOf));

  const existing = await db
    .select()
    .from(codSettlement)
    .where(
      and(
        eq(codSettlement.merchantId, input.merchantId),
        eq(codSettlement.periodStart, wantedPeriod.periodStart),
        eq(codSettlement.periodEnd, wantedPeriod.periodEnd),
      ),
    );
  // Only an OPEN run blocks a new one. A paid period still accepts a
  // supplementary run for cash banked after the payout, and a rejected one
  // released its money — see the partial index on cod_settlement. The guard
  // against paying a parcel twice is `claimedEntryIds()`, not this.
  const OPEN_STATUSES = new Set(["draft", "proposed", "approved", "on_hold"]);
  const live = existing.find((row) => OPEN_STATUSES.has(row.status));
  if (live) {
    fail(
      "CONFLICT",
      problem(
        "settlement-exists",
        "A run is already open for this period",
        409,
        `${merchant!.name} already has settlement ${live.code} open for this period (${live.status}). Finish or reject it before drafting another.`,
        { settlementId: live.id, code: live.code, status: live.status },
      ),
    );
  }

  const preview = await settlementPreview({
    merchantId: input.merchantId,
    period: wantedPeriod,
    deductions: input.deductions,
    asOf: input.asOf,
  });

  if (preview.lines.length === 0) {
    fail(
      "BAD_REQUEST",
      problem(
        "nothing-to-settle",
        "Nothing to settle",
        422,
        `No banked COD is awaiting settlement for ${preview.merchantName} in ${formatLkDate(preview.period.periodStart)} – ${formatLkDate(preview.period.periodEnd)}.`,
        { period: preview.period, heldParcels: preview.heldParcels.length },
      ),
    );
  }

  if (preview.netCents < 0) {
    // Refused rather than paid as a negative: a payout file cannot carry a
    // negative amount, and netting it against a future week silently would
    // hide the debt. Finance raises an invoice for the difference instead.
    fail(
      "BAD_REQUEST",
      problem(
        "deductions-exceed-gross",
        "Deductions exceed collections",
        422,
        `Deductions of ${formatLkr(preview.deductionsCents)} exceed the ${formatLkr(preview.grossCents)} collected. Invoice the difference instead of settling a negative amount.`,
        { grossCents: preview.grossCents, deductionsCents: preview.deductionsCents },
      ),
    );
  }

  const id = prefixedId("stl");
  const blocked = preview.blockingHolds.length > 0;

  const { code } = await insertWithFreshCode("cod_settlement", () => mintSettlementCode(preview.period.periodEnd), (code) => db.insert(codSettlement).values({
    id,
    code,
    merchantId: input.merchantId,
    merchantName: preview.merchantName,
    periodStart: preview.period.periodStart,
    periodEnd: preview.period.periodEnd,
    payoutDate: preview.period.payoutDate,
    grossCents: preview.grossCents,
    deductionsCents: preview.deductionsCents,
    netCents: preview.netCents,
    // A run built while a merchant-level hold is open opens held, not draft:
    // the work of preparing it is useful, moving the money is not allowed.
    status: blocked ? "on_hold" : "draft",
    holdReason: blocked
      ? preview.blockingHolds.map((hold) => hold.detail).join(" | ")
      : null,
    createdById: input.actor.userId!,
    createdByName: input.actor.name ?? input.actor.userId!,
  }));

  for (const line of preview.lines) {
    await db.insert(codSettlementLine).values({
      id: prefixedId("stll"),
      settlementId: id,
      type: line.type,
      parcelId: line.parcelId,
      awb: line.awb,
      amountCents: line.amountCents,
      description: line.description,
      entryId: line.entryId,
    });
  }

  await writeAudit({
    entity: "cod_settlement",
    entityId: id,
    action: "cod.settlement_created",
    actor: input.actor,
    after: {
      code,
      merchantId: input.merchantId,
      period: `${preview.period.periodStart}..${preview.period.periodEnd}`,
      grossCents: preview.grossCents,
      deductionsCents: preview.deductionsCents,
      netCents: preview.netCents,
      lineCount: preview.lines.length,
      heldParcels: preview.heldParcels.length,
      status: blocked ? "on_hold" : "draft",
    },
  });

  const detail = await getSettlement(id);
  return { settlement: detail.settlement, lines: detail.lines, preview };
}

export async function getSettlement(id: string): Promise<{
  settlement: SettlementRow;
  lines: SettlementLineRow[];
  /** Recomputed from the lines every read — a header cannot drift unnoticed. */
  derived: { grossCents: number; deductionsCents: number; netCents: number };
  balanced: boolean;
}> {
  const [settlement] = await db.select().from(codSettlement).where(eq(codSettlement.id, id));
  if (!settlement) errors.notFound("Settlement");
  const lines = await db
    .select()
    .from(codSettlementLine)
    .where(eq(codSettlementLine.settlementId, id))
    .orderBy(asc(codSettlementLine.type));
  const derived = totalsFor(lines);
  return {
    settlement: settlement!,
    lines,
    derived,
    balanced:
      derived.grossCents === settlement!.grossCents &&
      derived.deductionsCents === settlement!.deductionsCents &&
      derived.netCents === settlement!.netCents,
  };
}

/** Hand a draft to a checker. Still no money moved. */
export async function proposeSettlement(input: {
  settlementId: string;
  actor: Principal;
}): Promise<SettlementRow> {
  const { settlement } = await getSettlement(input.settlementId);
  if (settlement.status !== "draft") {
    errors.conflict(`${settlement.code} is ${settlement.status}; only a draft can be proposed.`, {
      currentStatus: settlement.status,
    });
  }
  await db
    .update(codSettlement)
    .set({ status: "proposed", proposedAt: new Date() })
    .where(eq(codSettlement.id, input.settlementId));
  await writeAudit({
    entity: "cod_settlement",
    entityId: input.settlementId,
    action: "cod.settlement_proposed",
    actor: input.actor,
    before: { status: "draft" },
    after: { status: "proposed", netCents: settlement.netCents },
  });
  return (await getSettlement(input.settlementId)).settlement;
}

/**
 * §8: "maker–checker: the creator cannot approve their own run. Approval is
 * audited."
 *
 * The refusal is by user id and has no override. It also re-reads the holds:
 * a variance found after the run was drafted must still stop it, or the control
 * only works for problems discovered in the right order.
 */
export async function approveSettlement(input: {
  settlementId: string;
  actor: Principal;
}): Promise<SettlementRow> {
  const { settlement, derived, balanced } = await getSettlement(input.settlementId);

  if (settlement.status !== "proposed") {
    errors.conflict(
      `${settlement.code} is ${settlement.status}; only a proposed run can be approved.`,
      { currentStatus: settlement.status },
    );
  }
  if (!input.actor?.userId) {
    fail(
      "FORBIDDEN",
      problem(
        "approver-unknown",
        "Named approver required",
        403,
        "§8 requires an identified approver, different from the run's creator.",
      ),
    );
  }
  if (input.actor.userId === settlement.createdById) {
    fail(
      "FORBIDDEN",
      problem(
        "maker-checker",
        "Maker cannot approve their own settlement",
        403,
        `${settlement.code} was created by ${settlement.createdByName}. §8 requires a different approver.`,
        { createdById: settlement.createdById, approverId: input.actor.userId },
      ),
    );
  }
  if (!balanced) {
    fail(
      "CONFLICT",
      problem(
        "header-line-mismatch",
        "Settlement totals do not match its lines",
        409,
        `${settlement.code} says net ${formatLkr(settlement.netCents)} but its lines total ${formatLkr(derived.netCents)}. It cannot be approved.`,
        { header: settlement.netCents, lines: derived.netCents },
      ),
    );
  }

  const holds = await merchantHoldState(settlement.merchantId);
  if (holds.blockingHolds.length > 0) {
    await db
      .update(codSettlement)
      .set({
        status: "on_hold",
        holdReason: holds.blockingHolds.map((hold) => hold.detail).join(" | "),
      })
      .where(eq(codSettlement.id, input.settlementId));
    fail(
      "CONFLICT",
      problem(
        "settlement-hold",
        "Settlement is on hold",
        409,
        `${holds.blockingHolds.length} open hold(s) block ${settlement.merchantName}'s payout (§8). Clear them, then approve.`,
        { holds: holds.blockingHolds.map((hold) => ({ id: hold.id, detail: hold.detail })) },
      ),
    );
  }

  await db
    .update(codSettlement)
    .set({
      status: "approved",
      approvedById: input.actor.userId!,
      approvedByName: input.actor.name ?? input.actor.userId!,
      approvedAt: new Date(),
    })
    .where(eq(codSettlement.id, input.settlementId));

  await writeAudit({
    entity: "cod_settlement",
    entityId: input.settlementId,
    action: "cod.settlement_approved",
    actor: input.actor,
    before: { status: "proposed", createdById: settlement.createdById },
    after: {
      status: "approved",
      approvedById: input.actor.userId,
      netCents: settlement.netCents,
      payoutDate: settlement.payoutDate,
    },
  });

  await enqueue("cod.settlement_approved", {
    settlementId: settlement.id,
    code: settlement.code,
    merchantId: settlement.merchantId,
    merchantName: settlement.merchantName,
    netCents: settlement.netCents,
    payoutDate: settlement.payoutDate,
    approvedByName: input.actor.name ?? input.actor.userId,
  });

  return (await getSettlement(input.settlementId)).settlement;
}

export async function rejectSettlement(input: {
  settlementId: string;
  reason: string;
  actor: Principal;
}): Promise<SettlementRow> {
  const { settlement } = await getSettlement(input.settlementId);
  if (settlement.status === "paid") {
    errors.conflict(`${settlement.code} has already been paid; raise a dispute instead.`);
  }
  if (!input.reason?.trim()) {
    fail(
      "BAD_REQUEST",
      problem("reason-required", "Reason required", 422, "A rejected run must say why."),
    );
  }
  await db
    .update(codSettlement)
    .set({ status: "rejected", rejectedReason: input.reason })
    .where(eq(codSettlement.id, input.settlementId));
  await writeAudit({
    entity: "cod_settlement",
    entityId: input.settlementId,
    action: "cod.settlement_rejected",
    actor: input.actor,
    before: { status: settlement.status },
    after: { status: "rejected", reason: input.reason },
  });
  // Rejecting releases the money: `claimedEntryIds()` ignores rejected runs, so
  // the same collections are eligible again for a corrected run.
  return (await getSettlement(input.settlementId)).settlement;
}

/** Stop a run by hand — §8's "settlement hold → blocks payout", used by ops. */
export async function holdSettlement(input: {
  settlementId: string;
  reason: string;
  actor: Principal;
}): Promise<SettlementRow> {
  const { settlement } = await getSettlement(input.settlementId);
  if (settlement.status === "paid") {
    errors.conflict(`${settlement.code} has already been paid; a hold would change nothing.`);
  }
  if (!input.reason?.trim()) {
    fail(
      "BAD_REQUEST",
      problem("reason-required", "Reason required", 422, "A hold must say what is wrong."),
    );
  }
  await db
    .update(codSettlement)
    .set({ status: "on_hold", holdReason: input.reason })
    .where(eq(codSettlement.id, input.settlementId));
  await writeAudit({
    entity: "cod_settlement",
    entityId: input.settlementId,
    action: "cod.settlement_held",
    actor: input.actor,
    before: { status: settlement.status },
    after: { status: "on_hold", holdReason: input.reason },
  });
  return (await getSettlement(input.settlementId)).settlement;
}

/**
 * Release a held run back to draft — never straight to approved. Whatever was
 * wrong may have changed the numbers, so it goes through maker–checker again.
 */
export async function releaseSettlement(input: {
  settlementId: string;
  note: string;
  actor: Principal;
}): Promise<SettlementRow> {
  const { settlement } = await getSettlement(input.settlementId);
  if (settlement.status !== "on_hold") {
    errors.conflict(`${settlement.code} is ${settlement.status}, not on hold.`);
  }
  if (!input.note?.trim()) {
    fail(
      "BAD_REQUEST",
      problem("note-required", "Note required", 422, "Releasing a hold requires an explanation."),
    );
  }
  const holds = await merchantHoldState(settlement.merchantId);
  if (holds.blockingHolds.length > 0) {
    errors.conflict(
      `${holds.blockingHolds.length} merchant-level hold(s) are still open; clear those first.`,
      { holds: holds.blockingHolds.map((hold) => hold.id) },
    );
  }
  await db
    .update(codSettlement)
    .set({ status: "draft", holdReason: null, proposedAt: null })
    .where(eq(codSettlement.id, input.settlementId));
  await writeAudit({
    entity: "cod_settlement",
    entityId: input.settlementId,
    action: "cod.settlement_released",
    actor: input.actor,
    before: { status: "on_hold", holdReason: settlement.holdReason },
    after: { status: "draft", note: input.note },
  });
  return (await getSettlement(input.settlementId)).settlement;
}

// ──────────────────────────────────────────────── checkpoint 5 — the payout

/**
 * §8 checkpoint 5 — "Payout executed, UTR recorded, remittance advice sent."
 *
 * This is where the ledger finally moves: a SETTLE for what left the bank, a
 * FEE for each deduction NatEx kept, and a TAX entry if tax is ever switched
 * on. Together they debit MERCHANT_PAYABLE by the gross, which is exactly what
 * the ACCRUE entries credited when the cash was banked — so a fully settled
 * merchant's payable returns to zero, and `merchantPayableCents()` proves it.
 */
export async function recordPayout(input: {
  settlementId: string;
  /** The bank's own transaction reference. Required: §8 says "UTR recorded". */
  utr: string;
  actor: Principal;
}): Promise<{
  settlement: SettlementRow;
  entries: { settle: string | null; fees: string[]; tax: string | null };
  payableAfterCents: number;
}> {
  const { settlement, lines, balanced } = await getSettlement(input.settlementId);

  if (settlement.status !== "approved") {
    errors.conflict(
      `${settlement.code} is ${settlement.status}; only an approved run can be paid.`,
      { currentStatus: settlement.status },
    );
  }
  if (!input.utr?.trim()) {
    fail(
      "BAD_REQUEST",
      problem(
        "utr-required",
        "UTR required",
        422,
        "§8 checkpoint 5 requires the bank's transaction reference to be recorded with the payout.",
      ),
    );
  }
  if (!balanced) {
    errors.conflict(`${settlement.code}'s totals no longer match its lines; it cannot be paid.`);
  }

  const holds = await merchantHoldState(settlement.merchantId);
  if (holds.blockingHolds.length > 0) {
    fail(
      "CONFLICT",
      problem(
        "settlement-hold",
        "Payout blocked by an open hold",
        409,
        `${settlement.merchantName} has ${holds.blockingHolds.length} open hold(s). §8: any open variance blocks that merchant's payout.`,
        { holds: holds.blockingHolds.map((hold) => hold.id) },
      ),
    );
  }

  const fees: string[] = [];
  let taxId: string | null = null;
  let settleId: string | null = null;

  // One FEE entry per deduction line, so the ledger keeps the parcel dimension
  // the lines have. Zero-amount lines (waived fees) post nothing — `posting()`
  // rightly refuses a zero entry — but they stay on the settlement as the
  // record that the charge was considered.
  for (const line of lines) {
    if (line.amountCents >= 0) continue;
    const amount = -line.amountCents;
    const entry = await appendLedgerEntry({
      type: line.type === "withholding_tax" ? "TAX" : "FEE",
      amountCents: amount,
      mode: "adjustment",
      ref: input.utr,
      parcelId: line.parcelId,
      awb: line.awb,
      merchantId: settlement.merchantId,
      settlementId: settlement.id,
      note: `${line.type}: ${line.description}`,
      actor: input.actor,
    });
    if (line.type === "withholding_tax") taxId = entry.id;
    else fees.push(entry.id);
  }

  if (settlement.netCents > 0) {
    const entry = await appendLedgerEntry({
      type: "SETTLE",
      amountCents: settlement.netCents,
      mode: "bank",
      ref: input.utr,
      merchantId: settlement.merchantId,
      settlementId: settlement.id,
      note: `Payout ${settlement.code} for ${formatLkDate(settlement.periodStart)}–${formatLkDate(settlement.periodEnd)}`,
      actor: input.actor,
    });
    settleId = entry.id;
  }

  // Stamp the accruals this run discharged. A dimension backfill on an
  // append-only table, the same as `depositId` at checkpoint 2: what the entry
  // recorded is untouched, it simply now knows which payout carried it.
  const entryIds = lines.map((line) => line.entryId).filter((id): id is string => Boolean(id));
  if (entryIds.length > 0) {
    await db
      .update(codEntry)
      .set({ settlementId: settlement.id })
      .where(inArray(codEntry.id, entryIds));
  }

  const paidAt = new Date();
  await db
    .update(codSettlement)
    .set({ status: "paid", utr: input.utr.trim(), paidAt })
    .where(eq(codSettlement.id, input.settlementId));

  await writeAudit({
    entity: "cod_settlement",
    entityId: input.settlementId,
    action: "cod.settlement_paid",
    actor: input.actor,
    before: { status: "approved" },
    after: {
      status: "paid",
      utr: input.utr.trim(),
      netCents: settlement.netCents,
      settleEntryId: settleId,
      feeEntryIds: fees,
      taxEntryId: taxId,
    },
  });

  // The remittance advice (§8 step 5) goes out through the outbox, so a
  // messaging outage delays the advice rather than failing a recorded payout.
  await enqueue("cod.settlement_paid", {
    settlementId: settlement.id,
    code: settlement.code,
    merchantId: settlement.merchantId,
    merchantName: settlement.merchantName,
    periodStart: settlement.periodStart,
    periodEnd: settlement.periodEnd,
    grossCents: settlement.grossCents,
    deductionsCents: settlement.deductionsCents,
    netCents: settlement.netCents,
    utr: input.utr.trim(),
    lineCount: lines.length,
  });

  /**
   * And tell the merchant their money moved (client-confirmed, §8 step 5's
   * "remittance advice" made concrete).
   *
   * On `paid` only, never on `approved`: an approved run has no UTR yet, and a
   * merchant told "released" before the bank moves will phone the desk the
   * same afternoon asking where it is.
   *
   * A second outbox row rather than a branch inside the alert handler, because
   * these two things fail independently — a messaging gateway outage must not
   * cost finance its durable record of the payout, and a merchant with no
   * phone on file must not retry the alert.
   */
  const payeeMerchant = await getMerchant(settlement.merchantId);
  await enqueue("notify.dispatch", {
    templateKey: "settlement.paid",
    merchantId: settlement.merchantId,
    toPhone: payeeMerchant?.contactPhone ?? null,
    vars: {
      code: settlement.code,
      merchantName: settlement.merchantName,
      periodStart: formatLkDate(settlement.periodStart),
      periodEnd: formatLkDate(settlement.periodEnd),
      // Pre-formatted: a template must never do money arithmetic.
      netAmount: formatLkr(settlement.netCents),
      deductions: formatLkr(settlement.deductionsCents),
      lineCount: lines.length,
      utr: input.utr.trim(),
    },
  });

  return {
    settlement: (await getSettlement(input.settlementId)).settlement,
    entries: { settle: settleId, fees, tax: taxId },
    payableAfterCents: await merchantPayableCents(settlement.merchantId),
  };
}

// ─────────────────────────────────────────────────────────── the payout file

export interface PayoutCsvRow {
  beneficiary: string;
  account: string;
  branch: string;
  amount: string;
  reference: string;
}

/**
 * The bank-agnostic payout file the client asked for: beneficiary, account,
 * branch, amount, reference. No bank-specific header, because the client named
 * no bank — this uploads to whichever portal they use.
 *
 * Exports approved runs only, and stamps `exportedAt` so the same run is not
 * silently pushed to the bank twice. A deliberate re-export passes `force`,
 * which is audited.
 */
export async function exportPayoutCsv(input: {
  settlementIds: string[];
  force?: boolean;
  actor: Principal;
}): Promise<{ csv: string; rows: PayoutCsvRow[]; totalCents: number; exported: string[] }> {
  if (input.settlementIds.length === 0) {
    fail(
      "BAD_REQUEST",
      problem("no-settlements", "Nothing to export", 422, "Name at least one settlement."),
    );
  }

  const rows: PayoutCsvRow[] = [];
  const exported: string[] = [];
  let totalCents = 0;

  for (const id of input.settlementIds) {
    const { settlement } = await getSettlement(id);
    if (settlement.status !== "approved" && settlement.status !== "paid") {
      errors.conflict(
        `${settlement.code} is ${settlement.status}; only an approved run can go in the payout file.`,
        { settlementId: id, status: settlement.status },
      );
    }
    if (settlement.exportedAt && !input.force) {
      // Its own problem type, not a generic conflict: this is the one refusal
      // here the user can override, and the portal has to be able to tell it
      // apart to offer the "send it again" confirmation.
      fail(
        "CONFLICT",
        problem(
          "already-exported",
          "Already sent to the bank",
          409,
          `${settlement.code} was already exported on ${settlement.exportedAt.toISOString()}. Re-export only if the first file never reached the bank.`,
          { settlementId: id, exportedAt: settlement.exportedAt, forcable: true },
        ),
      );
    }
    if (settlement.netCents <= 0) {
      errors.conflict(`${settlement.code} has nothing to pay (${formatLkr(settlement.netCents)}).`);
    }

    const payout = await getMerchantPayout(settlement.merchantId);
    if (!payout) {
      fail(
        "CONFLICT",
        problem(
          "payout-details-missing",
          "Merchant payout details missing",
          409,
          `${settlement.merchantName} has no bank beneficiary on file, so ${settlement.code} cannot be paid. Record them first.`,
          { merchantId: settlement.merchantId, settlementId: id },
        ),
      );
    }

    rows.push({
      beneficiary: payout!.beneficiaryName,
      account: payout!.accountNumber,
      branch: `${payout!.bankName} — ${payout!.branchName}`,
      // Rupees with two decimals: a bank portal takes a decimal amount, and
      // this is the one boundary where cents become a formatted number (§9).
      amount: (settlement.netCents / 100).toFixed(2),
      reference: settlement.code,
    });
    totalCents += settlement.netCents;
    exported.push(id);

    await db
      .update(codSettlement)
      .set({ exportedAt: new Date() })
      .where(eq(codSettlement.id, id));
    await writeAudit({
      entity: "cod_settlement",
      entityId: id,
      action: "cod.settlement_exported",
      actor: input.actor,
      after: {
        netCents: settlement.netCents,
        beneficiary: payout!.beneficiaryName,
        account: mask(payout!.accountNumber),
        reExport: Boolean(settlement.exportedAt),
      },
    });
  }

  const header = "Beneficiary Name,Account Number,Bank Branch,Amount (LKR),Reference";
  const body = rows.map((row) =>
    [row.beneficiary, row.account, row.branch, row.amount, row.reference]
      .map(csvCell)
      .join(","),
  );
  return { csv: [header, ...body].join("\n"), rows, totalCents, exported };
}

/** Quote a CSV cell only when it needs it, and never let one break the file. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

// ───────────────────────────────────────────────────────────── read paths

export interface SettlementFilter {
  merchantId?: string;
  status?: ("draft" | "proposed" | "approved" | "paid" | "rejected" | "on_hold")[];
  /** Matches the run code or the merchant name, case-insensitively. */
  q?: string;
  /**
   * Restrict to runs a merchant may see. Drafts, proposals, rejections and a
   * run held before anyone approved it are the finance desk's working state —
   * showing them would read as a promise of money (§8 maker–checker).
   */
  merchantView?: boolean;
  limit?: number;
  offset?: number;
}

/** A run is a promise to the merchant once approved; see `merchantView`. */
export function merchantMaySee(run: Pick<SettlementRow, "status" | "approvedAt">): boolean {
  return run.status === "approved" || run.status === "paid" || (run.status === "on_hold" && run.approvedAt !== null);
}

function settlementWhere(filter?: SettlementFilter) {
  const conditions = [];
  if (filter?.merchantId) conditions.push(eq(codSettlement.merchantId, filter.merchantId));
  if (filter?.status?.length) conditions.push(inArray(codSettlement.status, filter.status));
  if (filter?.merchantView) {
    conditions.push(
      sql`(${codSettlement.status} in ('approved', 'paid') or (${codSettlement.status} = 'on_hold' and ${codSettlement.approvedAt} is not null))`,
    );
  }
  const q = filter?.q?.trim().toLowerCase();
  if (q) {
    const pattern = `%${q}%`;
    conditions.push(
      sql`(lower(${codSettlement.code}) like ${pattern} or lower(${codSettlement.merchantName}) like ${pattern})`,
    );
  }
  return conditions.length ? and(...conditions) : undefined;
}

export async function listSettlements(filter?: SettlementFilter): Promise<SettlementRow[]> {
  return db
    .select()
    .from(codSettlement)
    .where(settlementWhere(filter))
    .orderBy(desc(codSettlement.createdAt))
    .limit(Math.min(filter?.limit ?? 50, 200))
    .offset(filter?.offset ?? 0);
}

/** One page plus the filtered total — the finance register's server-side paging (§11). */
export async function settlementPage(
  filter: SettlementFilter,
): Promise<{ rows: SettlementRow[]; total: number }> {
  const [rows, [count]] = await Promise.all([
    listSettlements(filter),
    db.select({ n: sql<number>`count(*)` }).from(codSettlement).where(settlementWhere(filter)),
  ]);
  return { rows, total: Number(count?.n ?? 0) };
}

/**
 * One merchant's money in one object, for the merchant and finance portals:
 * what is owed, what is settled, what is stuck and why.
 */
export async function merchantStatement(merchantId: string, opts?: { merchantView?: boolean }): Promise<{
  merchantId: string;
  payableCents: number;
  accountBalances: Record<string, number>;
  settlements: SettlementRow[];
  openHolds: CodHoldRow[];
  payout: MerchantPayoutRow | null;
  unsettledParcelCount: number;
}> {
  const rows = await db.select().from(codEntry).where(eq(codEntry.merchantId, merchantId));
  const live = liveEntries(rows);
  const [unsettled] = await db
    .select({ n: sql<number>`count(*)` })
    .from(codEntry)
    .where(
      and(
        eq(codEntry.merchantId, merchantId),
        eq(codEntry.type, "ACCRUE"),
        isNull(codEntry.settlementId),
        isNull(codEntry.reversedById),
      ),
    );

  return {
    merchantId,
    payableCents: merchantPayable(live),
    accountBalances: {
      [ACCOUNTS.MERCHANT_PAYABLE]: balances(live)[ACCOUNTS.MERCHANT_PAYABLE] ?? 0,
      [ACCOUNTS.FEE_INCOME]: balances(live)[ACCOUNTS.FEE_INCOME] ?? 0,
    },
    settlements: await listSettlements({ merchantId, limit: 20, merchantView: opts?.merchantView }),
    openHolds: await db
      .select()
      .from(codHold)
      .where(and(eq(codHold.merchantId, merchantId), eq(codHold.status, "open"))),
    payout: await getMerchantPayout(merchantId),
    unsettledParcelCount: unsettled?.n ?? 0,
  };
}

/**
 * Merchants with banked COD waiting to be settled — the finance portal's work
 * queue for the week.
 */
export async function settlementDue(period?: SettlementPeriod): Promise<
  {
    merchantId: string;
    merchantName: string | null;
    parcelCount: number;
    grossCents: number;
  }[]
> {
  const window = period ?? (await currentPeriod());
  const claimed = await claimedEntryIds();
  const rows = await db
    .select()
    .from(codEntry)
    .where(and(eq(codEntry.type, "ACCRUE"), isNull(codEntry.reversedById)));

  const byMerchant = new Map<string, { parcelCount: number; grossCents: number }>();
  for (const row of rows) {
    if (!row.merchantId) continue;
    const day = colomboToday(row.ts);
    if (day < window.periodStart || day > window.periodEnd) continue;
    if (claimed.has(row.id)) continue;
    const bucket = byMerchant.get(row.merchantId) ?? { parcelCount: 0, grossCents: 0 };
    bucket.parcelCount += 1;
    bucket.grossCents += row.amountCents;
    byMerchant.set(row.merchantId, bucket);
  }

  const out = [];
  for (const [merchantId, bucket] of byMerchant) {
    const merchant = await getMerchant(merchantId);
    out.push({ merchantId, merchantName: merchant?.name ?? null, ...bucket });
  }
  return out.sort((a, b) => b.grossCents - a.grossCents);
}
