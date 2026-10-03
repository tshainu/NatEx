/**
 * Merchant invoicing, credit notes and AR ageing — §10 M4, "Invoicing with
 * VAT/SSCL, credit notes, AR ageing".
 *
 * ─────────────────────────────────────────────────────────── two open questions
 *
 * §15 q3 — "Rate card structure — zones, weight slabs, surcharges, COD fee
 * model?" — IS STILL OPEN. Nothing in this system can price a delivery, so
 * NOTHING HERE INVENTS A FREIGHT RATE. An invoice is built from charges NatEx
 * can actually evidence:
 *
 *   1. the deduction lines of settlement runs that have already been PAID —
 *      money NatEx kept out of a COD payout, which the merchant is entitled to
 *      a tax document for; and
 *   2. charges a finance user enters by hand, each with a description.
 *
 * When the rate card is answered, a pricing module supplies (2) automatically
 * and nothing else here changes.
 *
 * §15 q10 — "Invoice format and VAT/SSCL treatment for COD fees?" — IS ALSO
 * STILL OPEN. VAT (18%) and SSCL (2.5%) are implemented, stacked in the Sri
 * Lankan order (SSCL on the charge, VAT on charge + SSCL) and seeded OFF in
 * `cod_finance_config`. Every invoice therefore carries zero tax today, and
 * every preview says so in `notes`. THIS IS A FLAG, NOT A DECISION.
 *
 * ──────────────────────────────────────────────── billed vs. actually owed
 *
 * A charge already netted off a COD payout is billed but not chased: it lands
 * in `recoveredCents`, not `paidCents`, and AR ageing ignores it.
 *
 * DECIDED — net receivable, and it stays that way until the client says
 * otherwise. This began as an inference from §8's "deductions modelled
 * explicitly" plus the Net 14 credit terms (§15 q5); it was put to the client,
 * who left the call to us for now. The reasoning, recorded so the next person
 * does not have to re-derive it:
 *
 *   - A merchant's fees are deducted at settlement, so by the time the invoice
 *     exists the money is already with NatEx. Ageing it would put essentially
 *     every COD merchant permanently overdue, and the 61-90/90+ buckets — the
 *     ones a collections desk actually works — would be noise.
 *   - DSO computed over recovered charges measures nothing: there is no day
 *     sales stayed outstanding when they never did.
 *   - The invoice still SHOWS the recovered amount, with a note, so it remains
 *     a complete tax document. Nothing is hidden from the merchant's
 *     accountant; only the chase list is filtered.
 *
 * To reverse it to gross invoicing, two places change and nothing else:
 * `outstandingCents()` stops subtracting `recoveredCents`, and the ageing
 * query stops filtering them out. Both are covered by probe-invoicing.ts, so a
 * reversal will announce itself in the assertions rather than in production.
 *
 * STILL WORTH CONFIRMING at go-live, because it changes the numbers the client
 * reports rather than how the code behaves: if their auditor expects gross AR,
 * flip it before the first invoice is issued, not after.
 *
 * Invoices are immutable once issued, for the same reason `cod_entry` is: the
 * merchant's accountant has already filed the number. A correction is a credit
 * note that references the invoice.
 */

import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../../database";
import {
  codCreditNote,
  codInvoice,
  codInvoiceLine,
  codSettlement,
  codSettlementLine,
} from "../../database/schema/cod";
import { errors, fail, isUniqueViolationOn, problem } from "../../shared/errors";
import { formatLkr } from "../../shared/money";
import { writeAudit } from "../../shared/audit";
import { prefixedId } from "../../shared/ulid";
import { insertWithFreshCode, mintDocumentCode } from "../../shared/codes";
import { addDays, colomboToday, formatLkDate } from "../../shared/time";
import type { Principal } from "../../shared/auth";
import { getMerchant } from "../merchants/service";
import { CONFIG_KEYS, configValue, financeConfig, taxOn } from "./config";
import { currentPeriod, type SettlementPeriod } from "./settlement";

export type InvoiceRow = typeof codInvoice.$inferSelect;
export type InvoiceLineRow = typeof codInvoiceLine.$inferSelect;
export type CreditNoteRow = typeof codCreditNote.$inferSelect;

/** draft → issued → part_paid → paid, or void. */
export const INVOICE_STATUSES = ["draft", "issued", "part_paid", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Statuses that occupy the one-invoice-per-period slot. */
const LIVE_STATUSES: InvoiceStatus[] = ["draft", "issued", "part_paid", "paid"];

/**
 * Settlement deduction types that are a NatEx service charge, and therefore
 * belong on a tax invoice.
 *
 * `withholding_tax` is deliberately absent: it is tax collected for the state,
 * not revenue, and invoicing it would charge the merchant for their own
 * withholding. `cod_collected` is absent because it is the merchant's money,
 * not a charge.
 */
const BILLABLE_SETTLEMENT_LINE_TYPES = [
  "cod_fee",
  "rto_fee",
  "forwarding",
  "weight_discrepancy",
  "penalty",
  "adjustment",
] as const;

/** A charge a finance user adds by hand (or a future pricing module supplies). */
export interface InvoiceCharge {
  description: string;
  /** MONEY: positive cents per unit. */
  unitCents: number;
  quantity?: number;
  parcelId?: string | null;
  awb?: string | null;
  /** Whether it enters the SSCL/VAT base once tax is switched on. Default true. */
  taxable?: boolean;
  /** True only if the money was already kept out of a COD payout. */
  recovered?: boolean;
}

export interface DraftInvoiceLine {
  description: string;
  parcelId: string | null;
  awb: string | null;
  quantity: number;
  unitCents: number;
  amountCents: number;
  taxable: boolean;
  recovered: boolean;
  sourceId: string | null;
}

export interface InvoicePreview {
  merchantId: string;
  merchantName: string;
  merchantVatNo: string | null;
  period: SettlementPeriod;
  dueDate: string;
  lines: DraftInvoiceLine[];
  subtotalCents: number;
  /** Portion of the subtotal that would enter the tax base. */
  taxableCents: number;
  ssclCents: number;
  vatCents: number;
  totalCents: number;
  /** Already kept out of a COD payout — billed, not chased. */
  recoveredCents: number;
  /** What the merchant will actually be asked to pay. */
  receivableCents: number;
  /** Open questions and waivers a finance user must see before issuing. */
  notes: string[];
}

function mintInvoiceCode(periodEnd: string): string {
  return mintDocumentCode("INV", periodEnd);
}

function mintCreditNoteCode(day: string): string {
  return mintDocumentCode("CRN", day);
}

// ───────────────────────────────────────────────────────────── pure arithmetic

/**
 * Invoice totals from its lines and the tax rates in force.
 *
 * Pure, so §345's "unit tests cover the domain rules" can hold the tax
 * stacking to account without a database — which matters more here than
 * anywhere else in M4, because the rates are switched off today and a bug in
 * them would stay invisible until the day they are switched on.
 */
export function invoiceTotals(
  lines: readonly { amountCents: number; taxable: boolean; recovered: boolean }[],
  rates: { vatActive: boolean; vatBp: number; ssclActive: boolean; ssclBp: number },
): {
  subtotalCents: number;
  taxableCents: number;
  ssclCents: number;
  vatCents: number;
  totalCents: number;
  recoveredCents: number;
} {
  const sums = invoiceLineSums(lines);
  // Tax is computed on the taxable base as a whole, not line by line: rounding
  // each line separately and summing drifts from the figure on the merchant's
  // own return by a cent or two per line.
  const { ssclCents, vatCents } = taxOn(sums.taxableCents, rates);
  return {
    ...sums,
    ssclCents,
    vatCents,
    totalCents: sums.subtotalCents + ssclCents + vatCents,
  };
}

/**
 * Add up invoice lines without touching tax.
 *
 * Split out from `invoiceTotals()` because reading an existing invoice must
 * NOT recompute its tax: the stored SSCL/VAT are the rates that applied when
 * it was raised, and §15 q10 is still open, so today's config can differ from
 * the day the document was issued. A read reconciles the line amounts against
 * the stored subtotal and leaves the tax figures exactly as billed.
 */
export function invoiceLineSums(
  lines: readonly { amountCents: number; taxable: boolean; recovered: boolean }[],
): { subtotalCents: number; taxableCents: number; recoveredCents: number } {
  let subtotal = 0;
  let taxable = 0;
  let recovered = 0;
  for (const line of lines) {
    subtotal += line.amountCents;
    if (line.taxable) taxable += line.amountCents;
    if (line.recovered) recovered += line.amountCents;
  }
  return { subtotalCents: subtotal, taxableCents: taxable, recoveredCents: recovered };
}

/**
 * What a merchant still owes on one invoice.
 *
 * total − paid − credited − recovered. A recovered charge was never a
 * receivable (see the file header), so it is subtracted here rather than
 * waiting to be collected.
 */
export function invoiceOutstanding(invoice: {
  totalCents: number;
  paidCents: number;
  creditedCents: number;
  recoveredCents: number;
}): number {
  return (
    invoice.totalCents - invoice.paidCents - invoice.creditedCents - invoice.recoveredCents
  );
}

/** The status an issued invoice should carry, given what has been settled against it. */
export function settledStatus(invoice: {
  totalCents: number;
  paidCents: number;
  creditedCents: number;
  recoveredCents: number;
}): Extract<InvoiceStatus, "issued" | "part_paid" | "paid"> {
  const outstanding = invoiceOutstanding(invoice);
  if (outstanding <= 0) return "paid";
  if (invoice.paidCents > 0 || invoice.creditedCents > 0 || invoice.recoveredCents > 0) {
    return "part_paid";
  }
  return "issued";
}

/** The client's ageing buckets (§15 q5): 0-30 / 31-60 / 61-90 / 90+. */
export const AGEING_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/**
 * Which bucket a given age falls in.
 *
 * Measured in days PAST THE DUE DATE, so an invoice inside its Net 14 term
 * sits at zero and lands in 0-30 rather than being reported as overdue. The
 * client named the buckets but not the datum; `arAgeing()` reports
 * `notYetDueCents` separately so neither reading is lost.
 */
export function ageingBucket(daysPastDue: number): AgeingBucket {
  if (daysPastDue <= 30) return "0-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}

/** Whole days between two ISO dates (b − a). */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

// ──────────────────────────────────────────────────────────── the invoice

/** Settlement line ids already billed on some invoice — never bill one twice. */
async function billedSourceIds(): Promise<Set<string>> {
  const rows = await db
    .select({ sourceId: codInvoiceLine.sourceId })
    .from(codInvoiceLine)
    .innerJoin(codInvoice, eq(codInvoiceLine.invoiceId, codInvoice.id))
    .where(and(isNotNull(codInvoiceLine.sourceId), ne(codInvoice.status, "void")));
  const out = new Set<string>();
  for (const row of rows) if (row.sourceId) out.add(row.sourceId);
  return out;
}

/**
 * Build the invoice a period would produce, writing nothing.
 *
 * Shares every rule with `createInvoice()`, so what finance approves on screen
 * is computed by the code that issues it.
 */
export async function invoicePreview(input: {
  merchantId: string;
  period?: SettlementPeriod;
  charges?: InvoiceCharge[];
  asOf?: string;
}): Promise<InvoicePreview> {
  const merchant = await getMerchant(input.merchantId);
  if (!merchant) errors.notFound("Merchant");
  const period = input.period ?? (await currentPeriod(input.asOf));
  const today = input.asOf ?? colomboToday();

  const [cfg, billed] = await Promise.all([financeConfig(), billedSourceIds()]);
  const dueDays = cfg[CONFIG_KEYS.INVOICE_DUE_DAYS];

  const lines: DraftInvoiceLine[] = [];
  const notes: string[] = [];

  // ── 1. charges NatEx already deducted from a PAID settlement.
  //
  // Only paid runs: a charge on a run that has not been paid has not been
  // recovered from anyone yet, and billing it as recovered would tell the
  // merchant their money is gone before it is.
  const deductions = await db
    .select({
      id: codSettlementLine.id,
      type: codSettlementLine.type,
      parcelId: codSettlementLine.parcelId,
      awb: codSettlementLine.awb,
      amountCents: codSettlementLine.amountCents,
      description: codSettlementLine.description,
      settlementCode: codSettlement.code,
      periodEnd: codSettlement.periodEnd,
    })
    .from(codSettlementLine)
    .innerJoin(codSettlement, eq(codSettlementLine.settlementId, codSettlement.id))
    .where(
      and(
        eq(codSettlement.merchantId, input.merchantId),
        eq(codSettlement.status, "paid"),
        inArray(codSettlementLine.type, [...BILLABLE_SETTLEMENT_LINE_TYPES]),
      ),
    )
    .orderBy(asc(codSettlementLine.type));

  let waivedCount = 0;
  for (const row of deductions) {
    if (row.periodEnd < period.periodStart || row.periodEnd > period.periodEnd) continue;
    if (billed.has(row.id)) continue;
    // Settlement deductions are stored negative (they reduce a payout); an
    // invoice charge is positive. Same money, opposite direction of travel.
    const amount = -row.amountCents;
    if (amount <= 0) {
      // A zero line is a waiver the settlement recorded deliberately (the
      // bundled COD fee, the promotional RTO fee). It is not billed, but the
      // merchant is told it was considered.
      waivedCount += 1;
      continue;
    }
    lines.push({
      description: `${row.description} (${row.settlementCode})`,
      parcelId: row.parcelId,
      awb: row.awb,
      quantity: 1,
      unitCents: amount,
      amountCents: amount,
      taxable: true,
      recovered: true,
      sourceId: row.id,
    });
  }
  if (waivedCount > 0) {
    notes.push(
      `${waivedCount} charge(s) in this period were waived at settlement (bundled COD fee per §15 q3, promotional RTO fee) and are not billed.`,
    );
  }

  // ── 2. hand-entered charges. Freight belongs here until §15 q3 is answered.
  for (const charge of input.charges ?? []) {
    const quantity = charge.quantity ?? 1;
    if (!Number.isInteger(charge.unitCents) || charge.unitCents <= 0) {
      fail(
        "BAD_REQUEST",
        problem(
          "invalid-charge",
          "Invalid charge",
          422,
          "An invoice charge must be a positive whole number of cents (§9: money is never a float).",
          { description: charge.description, unitCents: charge.unitCents },
        ),
      );
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      fail(
        "BAD_REQUEST",
        problem("invalid-charge", "Invalid charge", 422, "Quantity must be a positive whole number.", {
          description: charge.description,
          quantity,
        }),
      );
    }
    if (!charge.description?.trim()) {
      fail(
        "BAD_REQUEST",
        problem(
          "invalid-charge",
          "Invalid charge",
          422,
          "Every invoice line needs a description — a merchant cannot pay a charge nobody named.",
        ),
      );
    }
    lines.push({
      description: charge.description.trim(),
      parcelId: charge.parcelId ?? null,
      awb: charge.awb ?? null,
      quantity,
      unitCents: charge.unitCents,
      amountCents: charge.unitCents * quantity,
      taxable: charge.taxable ?? true,
      recovered: charge.recovered ?? false,
      sourceId: null,
    });
  }

  const rates = {
    vatActive: cfg[CONFIG_KEYS.VAT_ACTIVE] === 1,
    vatBp: cfg[CONFIG_KEYS.VAT_BP],
    ssclActive: cfg[CONFIG_KEYS.SSCL_ACTIVE] === 1,
    ssclBp: cfg[CONFIG_KEYS.SSCL_BP],
  };
  const totals = invoiceTotals(lines, rates);

  if (!rates.vatActive && !rates.ssclActive) {
    notes.push(
      "No VAT and no SSCL on this invoice. §15 q10 (invoice format and VAT/SSCL treatment) IS STILL AN OPEN QUESTION — the 18% VAT and 2.5% SSCL arithmetic is implemented and unit-tested but seeded off. Switching it on is a config change in cod_finance_config, not a code change.",
    );
  }
  if (!merchant!.vatNo) {
    notes.push(
      `${merchant!.name} has no VAT registration number on file. A Sri Lankan tax invoice needs the customer's VAT number once NatEx is registered.`,
    );
  }
  if (totals.recoveredCents > 0) {
    notes.push(
      `${formatLkr(totals.recoveredCents)} of this invoice was already deducted from COD payouts and is not receivable. It is shown so the invoice is a complete tax document.`,
    );
  }
  if (lines.length === 0) {
    notes.push(
      "Nothing chargeable found for this period. Freight is not priced onto invoices automatically: the rate cards in the system are placeholders until §15 q3 (rate card structure) is answered, so a freight charge has to be supplied by hand.",
    );
  }

  return {
    merchantId: input.merchantId,
    merchantName: merchant!.name,
    merchantVatNo: merchant!.vatNo ?? null,
    period,
    dueDate: addDays(today, dueDays),
    lines,
    ...totals,
    receivableCents: totals.totalCents - totals.recoveredCents,
    notes,
  };
}

/**
 * Create a draft invoice. Nothing is owed until it is issued.
 */
export async function createInvoice(input: {
  merchantId: string;
  period?: SettlementPeriod;
  charges?: InvoiceCharge[];
  asOf?: string;
  actor: Principal;
}): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[]; preview: InvoicePreview }> {
  if (!input.actor?.userId) {
    fail(
      "BAD_REQUEST",
      problem(
        "actor-required",
        "Named creator required",
        422,
        "An invoice has to name the finance user who raised it.",
      ),
    );
  }

  // The already-invoiced check comes BEFORE the preview is built, and has to.
  // Once a period's charges are billed they are no longer offered, so a second
  // attempt at the same period previews as empty — reporting "nothing to
  // invoice" there would send finance looking for missing activity when the
  // real answer is that the invoice already exists.
  const merchant = await getMerchant(input.merchantId);
  if (!merchant) errors.notFound("Merchant");
  const wantedPeriod = input.period ?? (await currentPeriod(input.asOf));

  const existing = await db
    .select()
    .from(codInvoice)
    .where(
      and(
        eq(codInvoice.merchantId, input.merchantId),
        eq(codInvoice.periodStart, wantedPeriod.periodStart),
        eq(codInvoice.periodEnd, wantedPeriod.periodEnd),
        inArray(codInvoice.status, LIVE_STATUSES),
      ),
    );
  if (existing.length > 0) {
    const live = existing[0]!;
    fail(
      "CONFLICT",
      problem(
        "invoice-exists",
        "This period is already invoiced",
        409,
        `${merchant!.name} already has invoice ${live.code} for this period (${live.status}). Void it or raise a credit note instead of invoicing twice.`,
        { invoiceId: live.id, code: live.code, currentStatus: live.status },
      ),
    );
  }

  const preview = await invoicePreview({
    merchantId: input.merchantId,
    period: wantedPeriod,
    charges: input.charges,
    asOf: input.asOf,
  });

  if (preview.lines.length === 0) {
    fail(
      "BAD_REQUEST",
      problem(
        "nothing-to-invoice",
        "Nothing to invoice",
        422,
        `No chargeable activity for ${preview.merchantName} in ${formatLkDate(preview.period.periodStart)} – ${formatLkDate(preview.period.periodEnd)}.`,
        { period: preview.period },
      ),
    );
  }

  const id = prefixedId("inv");
  const { code } = await insertWithFreshCode("cod_invoice", () => mintInvoiceCode(preview.period.periodEnd), (code) => db.insert(codInvoice).values({
    id,
    code,
    merchantId: input.merchantId,
    merchantName: preview.merchantName,
    merchantVatNo: preview.merchantVatNo,
    periodStart: preview.period.periodStart,
    periodEnd: preview.period.periodEnd,
    dueDate: preview.dueDate,
    subtotalCents: preview.subtotalCents,
    ssclCents: preview.ssclCents,
    vatCents: preview.vatCents,
    totalCents: preview.totalCents,
    paidCents: 0,
    creditedCents: 0,
    recoveredCents: preview.recoveredCents,
    status: "draft",
    createdByName: input.actor.name ?? input.actor.userId!,
  }));

  for (const line of preview.lines) {
    try {
      await db.insert(codInvoiceLine).values({
        id: prefixedId("invl"),
        invoiceId: id,
        description: line.description,
        parcelId: line.parcelId,
        awb: line.awb,
        quantity: line.quantity,
        unitCents: line.unitCents,
        amountCents: line.amountCents,
        taxable: line.taxable,
        sourceId: line.sourceId,
        recovered: line.recovered,
      });
    } catch (error) {
      // The backstop behind `billedSourceIds()`: two finance users invoicing
      // the same period at once would both pass the read. Whoever loses is
      // told plainly rather than being handed a raw constraint error.
      if (isUniqueViolationOn(error, "cod_invoice_line.source_id")) {
        fail(
          "CONFLICT",
          problem(
            "charge-already-billed",
            "That charge is already on an invoice",
            409,
            `${line.description} has already been billed. A settlement deduction can only be invoiced once.`,
            { sourceId: line.sourceId },
          ),
        );
      }
      throw error;
    }
  }

  await writeAudit({
    entity: "cod_invoice",
    entityId: id,
    action: "cod.invoice_created",
    actor: input.actor,
    after: {
      code,
      merchantId: input.merchantId,
      period: `${preview.period.periodStart}..${preview.period.periodEnd}`,
      subtotalCents: preview.subtotalCents,
      ssclCents: preview.ssclCents,
      vatCents: preview.vatCents,
      totalCents: preview.totalCents,
      recoveredCents: preview.recoveredCents,
      lineCount: preview.lines.length,
    },
  });

  const detail = await getInvoice(id);
  return { invoice: detail.invoice, lines: detail.lines, preview };
}

export async function getInvoice(id: string): Promise<{
  invoice: InvoiceRow;
  lines: InvoiceLineRow[];
  creditNotes: CreditNoteRow[];
  /**
   * Re-summed from the lines on every read, so a header cannot drift
   * unnoticed. Tax is the tax that was BILLED, carried through from the
   * header rather than recomputed — see `invoiceLineSums()`.
   */
  derived: ReturnType<typeof invoiceTotals>;
  balanced: boolean;
  outstandingCents: number;
}> {
  const [invoice] = await db.select().from(codInvoice).where(eq(codInvoice.id, id));
  if (!invoice) errors.notFound("Invoice");
  const lines = await db
    .select()
    .from(codInvoiceLine)
    .where(eq(codInvoiceLine.invoiceId, id));
  const creditNotes = await db
    .select()
    .from(codCreditNote)
    .where(eq(codCreditNote.invoiceId, id))
    .orderBy(desc(codCreditNote.issuedAt));

  // The tax on an issued invoice is a historical fact, not a calculation to
  // repeat: it was charged at the rates in force that day, and §15 q10 is
  // still open, so the config can legitimately have changed since. Only the
  // line amounts are re-summed, and only to prove the header still agrees
  // with them.
  const sums = invoiceLineSums(lines);
  const derived = {
    ...sums,
    ssclCents: invoice!.ssclCents,
    vatCents: invoice!.vatCents,
    totalCents: sums.subtotalCents + invoice!.ssclCents + invoice!.vatCents,
  };

  return {
    invoice: invoice!,
    lines,
    creditNotes,
    derived,
    balanced:
      derived.subtotalCents === invoice!.subtotalCents &&
      derived.totalCents === invoice!.totalCents &&
      sums.recoveredCents === invoice!.recoveredCents,
    outstandingCents: invoiceOutstanding(invoice!),
  };
}

/**
 * Issue a draft: the merchant now owes it, and the Net 14 clock starts.
 *
 * The due date is recomputed at issue rather than reused from the draft,
 * because credit terms run from the invoice date and a draft may have sat for
 * days.
 */
export async function issueInvoice(input: {
  invoiceId: string;
  asOf?: string;
  actor: Principal;
}): Promise<InvoiceRow> {
  const [invoice] = await db.select().from(codInvoice).where(eq(codInvoice.id, input.invoiceId));
  if (!invoice) errors.notFound("Invoice");
  if (invoice!.status !== "draft") {
    fail(
      "CONFLICT",
      problem(
        "invoice-not-draft",
        "Only a draft can be issued",
        409,
        `${invoice!.code} is ${invoice!.status}. An issued invoice is never re-issued — correct it with a credit note.`,
        { invoiceId: invoice!.id, currentStatus: invoice!.status },
      ),
    );
  }

  const today = input.asOf ?? colomboToday();
  const dueDays = await configValue(CONFIG_KEYS.INVOICE_DUE_DAYS);
  const dueDate = addDays(today, dueDays);
  const status = settledStatus(invoice!);

  await db
    .update(codInvoice)
    .set({ status, issuedAt: new Date(), dueDate })
    .where(eq(codInvoice.id, input.invoiceId));

  await writeAudit({
    entity: "cod_invoice",
    entityId: input.invoiceId,
    action: "cod.invoice_issued",
    actor: input.actor,
    before: { status: "draft" },
    after: {
      status,
      dueDate,
      totalCents: invoice!.totalCents,
      recoveredCents: invoice!.recoveredCents,
      outstandingCents: invoiceOutstanding(invoice!),
    },
  });

  const [row] = await db.select().from(codInvoice).where(eq(codInvoice.id, input.invoiceId));
  return row!;
}

/**
 * Record a payment received against an invoice.
 *
 * `reference` is the bank reference and is mandatory: a payment nobody can
 * trace to a bank statement is not a payment, it is a claim. It also makes the
 * write idempotent — the same reference twice is the same money.
 */
export async function recordInvoicePayment(input: {
  invoiceId: string;
  amountCents: number;
  reference: string;
  actor: Principal;
}): Promise<{ invoice: InvoiceRow; applied: boolean }> {
  const [invoice] = await db.select().from(codInvoice).where(eq(codInvoice.id, input.invoiceId));
  if (!invoice) errors.notFound("Invoice");
  if (invoice!.status === "draft") {
    fail(
      "CONFLICT",
      problem(
        "invoice-not-issued",
        "Nothing is owed on a draft",
        409,
        `${invoice!.code} has not been issued, so there is nothing to pay against it.`,
        { invoiceId: invoice!.id, currentStatus: invoice!.status },
      ),
    );
  }
  if (invoice!.status === "void") {
    fail(
      "CONFLICT",
      problem(
        "invoice-void",
        "That invoice is void",
        409,
        `${invoice!.code} was voided${invoice!.voidReason ? `: ${invoice!.voidReason}` : ""}. Money received against it belongs to another invoice.`,
        { invoiceId: invoice!.id },
      ),
    );
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    fail(
      "BAD_REQUEST",
      problem(
        "invalid-payment",
        "Invalid payment",
        422,
        "A payment must be a positive whole number of cents. A refund is a credit note, not a negative payment.",
        { amountCents: input.amountCents },
      ),
    );
  }
  if (!input.reference?.trim()) {
    fail(
      "BAD_REQUEST",
      problem(
        "reference-required",
        "Bank reference required",
        422,
        "A payment has to be traceable to a bank statement, so its reference is mandatory.",
      ),
    );
  }

  const outstanding = invoiceOutstanding(invoice!);
  if (input.amountCents > outstanding) {
    fail(
      "BAD_REQUEST",
      problem(
        "overpayment",
        "More than is outstanding",
        422,
        `${formatLkr(input.amountCents)} exceeds the ${formatLkr(outstanding)} outstanding on ${invoice!.code}. Apply the excess to another invoice rather than overpaying this one.`,
        { outstandingCents: outstanding, amountCents: input.amountCents },
      ),
    );
  }

  const paidCents = invoice!.paidCents + input.amountCents;
  const status = settledStatus({ ...invoice!, paidCents });

  await db
    .update(codInvoice)
    .set({ paidCents, status })
    .where(eq(codInvoice.id, input.invoiceId));

  await writeAudit({
    entity: "cod_invoice",
    entityId: input.invoiceId,
    action: "cod.invoice_paid",
    actor: input.actor,
    before: { paidCents: invoice!.paidCents, status: invoice!.status },
    after: {
      paidCents,
      status,
      amountCents: input.amountCents,
      reference: input.reference.trim(),
      outstandingCents: invoiceOutstanding({ ...invoice!, paidCents }),
    },
  });

  const [row] = await db.select().from(codInvoice).where(eq(codInvoice.id, input.invoiceId));
  return { invoice: row!, applied: true };
}

/**
 * Raise a credit note — the only way to reduce an issued invoice (§10 M4).
 *
 * Invoices are not edited for the same reason ledger entries are not: someone
 * downstream has already acted on the number. The note carries a reason, and
 * the dispute that justified it when it came from one.
 */
export async function issueCreditNote(input: {
  invoiceId: string;
  amountCents: number;
  reason: string;
  disputeId?: string | null;
  actor: Principal;
}): Promise<{ creditNote: CreditNoteRow; invoice: InvoiceRow }> {
  if (!input.actor?.userId) {
    fail(
      "BAD_REQUEST",
      problem(
        "actor-required",
        "Named issuer required",
        422,
        "A credit note reduces revenue, so it must name the finance user who issued it.",
      ),
    );
  }
  const [invoice] = await db.select().from(codInvoice).where(eq(codInvoice.id, input.invoiceId));
  if (!invoice) errors.notFound("Invoice");
  if (invoice!.status === "draft") {
    fail(
      "CONFLICT",
      problem(
        "invoice-not-issued",
        "A draft needs no credit note",
        409,
        `${invoice!.code} has not been issued — edit or void the draft instead.`,
        { invoiceId: invoice!.id, currentStatus: invoice!.status },
      ),
    );
  }
  if (invoice!.status === "void") {
    fail(
      "CONFLICT",
      problem("invoice-void", "That invoice is void", 409, `${invoice!.code} was voided; there is nothing to credit.`, {
        invoiceId: invoice!.id,
      }),
    );
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    fail(
      "BAD_REQUEST",
      problem(
        "invalid-credit-note",
        "Invalid credit note",
        422,
        "A credit note must be a positive whole number of cents; it reduces what the merchant owes.",
        { amountCents: input.amountCents },
      ),
    );
  }
  if (!input.reason?.trim()) {
    fail(
      "BAD_REQUEST",
      problem(
        "reason-required",
        "Reason required",
        422,
        "A credit note reduces NatEx's revenue and must say why.",
      ),
    );
  }

  // Creditable against the whole invoice, not just the unpaid part: a charge
  // that was wrong is still wrong after the merchant has paid it, and the
  // credit then sits on their account. What is refused is crediting more than
  // was ever billed.
  const creditable = invoice!.totalCents - invoice!.creditedCents;
  if (input.amountCents > creditable) {
    fail(
      "BAD_REQUEST",
      problem(
        "credit-exceeds-invoice",
        "More than the invoice",
        422,
        `${formatLkr(input.amountCents)} exceeds the ${formatLkr(creditable)} still creditable on ${invoice!.code}.`,
        { creditableCents: creditable, amountCents: input.amountCents },
      ),
    );
  }

  const id = prefixedId("crn");
  const { code } = await insertWithFreshCode("cod_credit_note", () => mintCreditNoteCode(colomboToday()), (code) => db.insert(codCreditNote).values({
    id,
    code,
    invoiceId: input.invoiceId,
    merchantId: invoice!.merchantId,
    amountCents: input.amountCents,
    reason: input.reason.trim(),
    disputeId: input.disputeId ?? null,
    issuedById: input.actor.userId!,
    issuedByName: input.actor.name ?? input.actor.userId!,
  }));

  const creditedCents = invoice!.creditedCents + input.amountCents;
  const status = settledStatus({ ...invoice!, creditedCents });
  await db
    .update(codInvoice)
    .set({ creditedCents, status })
    .where(eq(codInvoice.id, input.invoiceId));

  await writeAudit({
    entity: "cod_credit_note",
    entityId: id,
    action: "cod.credit_note_issued",
    actor: input.actor,
    after: {
      code,
      invoiceId: input.invoiceId,
      invoiceCode: invoice!.code,
      merchantId: invoice!.merchantId,
      amountCents: input.amountCents,
      reason: input.reason.trim(),
      disputeId: input.disputeId ?? null,
      invoiceStatus: status,
    },
  });

  const [row] = await db.select().from(codInvoice).where(eq(codInvoice.id, input.invoiceId));
  const [note] = await db.select().from(codCreditNote).where(eq(codCreditNote.id, id));
  return { creditNote: note!, invoice: row! };
}

/**
 * Void an invoice.
 *
 * Only while nothing has been settled against it. Once a merchant has paid or
 * been credited, the invoice is part of both parties' books and the correction
 * is a credit note — voiding it would erase a document the merchant has
 * already accounted for. A voided invoice releases its period, so the period
 * can be invoiced again (see the partial unique index on `cod_invoice`).
 */
export async function voidInvoice(input: {
  invoiceId: string;
  reason: string;
  actor: Principal;
}): Promise<InvoiceRow> {
  const [invoice] = await db.select().from(codInvoice).where(eq(codInvoice.id, input.invoiceId));
  if (!invoice) errors.notFound("Invoice");
  if (invoice!.status === "void") {
    errors.conflict("That invoice is already void.", { voidReason: invoice!.voidReason });
  }
  if (!input.reason?.trim()) {
    fail(
      "BAD_REQUEST",
      problem("reason-required", "Reason required", 422, "Voiding an invoice requires an explanation."),
    );
  }
  if (invoice!.paidCents > 0 || invoice!.creditedCents > 0) {
    fail(
      "CONFLICT",
      problem(
        "invoice-in-use",
        "Too late to void",
        409,
        `${invoice!.code} already carries ${formatLkr(invoice!.paidCents)} paid and ${formatLkr(invoice!.creditedCents)} credited. Raise a credit note for the full balance instead of voiding it.`,
        {
          invoiceId: invoice!.id,
          paidCents: invoice!.paidCents,
          creditedCents: invoice!.creditedCents,
        },
      ),
    );
  }

  await db
    .update(codInvoice)
    .set({ status: "void", voidReason: input.reason.trim() })
    .where(eq(codInvoice.id, input.invoiceId));

  // Release the settlement charges this invoice had claimed. The partial unique
  // index on `cod_invoice_line.source_id` cannot read the parent invoice's
  // status, so the void has to be mirrored onto the lines or the charge stays
  // blocked forever and can never be re-billed on the replacement invoice.
  await db
    .update(codInvoiceLine)
    .set({ voided: true })
    .where(eq(codInvoiceLine.invoiceId, input.invoiceId));

  await writeAudit({
    entity: "cod_invoice",
    entityId: input.invoiceId,
    action: "cod.invoice_voided",
    actor: input.actor,
    before: { status: invoice!.status, totalCents: invoice!.totalCents },
    after: { status: "void", reason: input.reason.trim() },
  });

  const [row] = await db.select().from(codInvoice).where(eq(codInvoice.id, input.invoiceId));
  return row!;
}

export interface InvoiceFilter {
  merchantId?: string;
  status?: InvoiceStatus[];
  overdueOnly?: boolean;
  asOf?: string;
  /** Matches the invoice code or the merchant name, case-insensitively. */
  q?: string;
  /** Restrict to invoices a merchant may see: issued onwards, never a draft or a void. */
  merchantView?: boolean;
  limit?: number;
  offset?: number;
}

/** Statuses a merchant sees. A draft is still being prepared; a void never stood. */
export const MERCHANT_VISIBLE_INVOICES: InvoiceStatus[] = ["issued", "part_paid", "paid"];

function invoiceWhere(filter?: InvoiceFilter) {
  const conditions = [];
  if (filter?.merchantId) conditions.push(eq(codInvoice.merchantId, filter.merchantId));
  if (filter?.status?.length) conditions.push(inArray(codInvoice.status, filter.status));
  if (filter?.merchantView) conditions.push(inArray(codInvoice.status, MERCHANT_VISIBLE_INVOICES));
  if (filter?.overdueOnly) {
    conditions.push(inArray(codInvoice.status, ["issued", "part_paid"]));
    conditions.push(sql`${codInvoice.dueDate} < ${filter.asOf ?? colomboToday()}`);
  }
  const q = filter?.q?.trim().toLowerCase();
  if (q) {
    const pattern = `%${q}%`;
    conditions.push(
      sql`(lower(${codInvoice.code}) like ${pattern} or lower(${codInvoice.merchantName}) like ${pattern})`,
    );
  }
  return conditions.length ? and(...conditions) : undefined;
}

export async function listInvoices(filter?: InvoiceFilter): Promise<InvoiceRow[]> {
  return db
    .select()
    .from(codInvoice)
    .where(invoiceWhere(filter))
    .orderBy(desc(codInvoice.createdAt))
    .limit(Math.min(filter?.limit ?? 100, 500))
    .offset(filter?.offset ?? 0);
}

/** One page plus the filtered total — server-side paging for the invoice register (§11). */
export async function invoicePage(
  filter: InvoiceFilter,
): Promise<{ rows: InvoiceRow[]; total: number }> {
  const [rows, [count]] = await Promise.all([
    listInvoices(filter),
    db.select({ n: sql<number>`count(*)` }).from(codInvoice).where(invoiceWhere(filter)),
  ]);
  return { rows, total: Number(count?.n ?? 0) };
}

// ──────────────────────────────────────────────────────────── AR ageing (§15 q5)

export interface AgeingRow {
  merchantId: string;
  merchantName: string;
  /** MONEY: cents outstanding, per bucket. */
  buckets: Record<AgeingBucket, number>;
  outstandingCents: number;
  /** Inside its credit term — not overdue at all. */
  notYetDueCents: number;
  oldestDays: number;
  invoiceCount: number;
}

/**
 * Accounts-receivable ageing: what each merchant owes, by age.
 *
 * Net 14 terms and 0-30/31-60/61-90/90+ buckets, per the client's answer to
 * §15 q5. There is no hard credit limit — also their answer — so this report
 * blocks nothing on its own; it is what a finance user acts on.
 *
 * Only `issued` and `part_paid` invoices are receivable. Drafts are not owed,
 * paid ones are done, and voided ones never existed.
 */
export async function arAgeing(input?: {
  asOf?: string;
  merchantId?: string;
}): Promise<{
  asOf: string;
  rows: AgeingRow[];
  totals: Record<AgeingBucket, number>;
  outstandingCents: number;
  notYetDueCents: number;
  creditTermDays: number;
  notes: string[];
}> {
  const asOf = input?.asOf ?? colomboToday();
  const creditTermDays = await configValue(CONFIG_KEYS.INVOICE_DUE_DAYS);

  const conditions = [inArray(codInvoice.status, ["issued", "part_paid"])];
  if (input?.merchantId) conditions.push(eq(codInvoice.merchantId, input.merchantId));
  const invoices = await db
    .select()
    .from(codInvoice)
    .where(and(...conditions))
    .orderBy(asc(codInvoice.dueDate));

  const byMerchant = new Map<string, AgeingRow>();
  const totals: Record<AgeingBucket, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  let outstandingTotal = 0;
  let notYetDueTotal = 0;

  for (const invoice of invoices) {
    const outstanding = invoiceOutstanding(invoice);
    // An invoice whose charges were all recovered at settlement nets to zero
    // here. It is not a receivable and must not age.
    if (outstanding <= 0) continue;

    const daysPastDue = Math.max(0, daysBetween(invoice.dueDate, asOf));
    const bucket = ageingBucket(daysPastDue);

    let row = byMerchant.get(invoice.merchantId);
    if (!row) {
      row = {
        merchantId: invoice.merchantId,
        merchantName: invoice.merchantName,
        buckets: { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 },
        outstandingCents: 0,
        notYetDueCents: 0,
        oldestDays: 0,
        invoiceCount: 0,
      };
      byMerchant.set(invoice.merchantId, row);
    }
    row.buckets[bucket] += outstanding;
    row.outstandingCents += outstanding;
    row.invoiceCount += 1;
    row.oldestDays = Math.max(row.oldestDays, daysPastDue);
    if (daysPastDue === 0) row.notYetDueCents += outstanding;

    totals[bucket] += outstanding;
    outstandingTotal += outstanding;
    if (daysPastDue === 0) notYetDueTotal += outstanding;
  }

  const rows = [...byMerchant.values()].sort((a, b) => b.outstandingCents - a.outstandingCents);
  const notes = [
    `Net ${creditTermDays} credit terms and no hard credit limit, per the client's answer to §15 q5. Nothing here blocks a booking; it is a finance work queue.`,
    "Buckets are days PAST THE DUE DATE, so an invoice inside its credit term sits in 0-30. notYetDueCents reports that portion separately.",
    "Charges already deducted from a COD payout are excluded — they were never receivable.",
  ];

  return {
    asOf,
    rows,
    totals,
    outstandingCents: outstandingTotal,
    notYetDueCents: notYetDueTotal,
    creditTermDays,
    notes,
  };
}

/** One merchant's receivable position, with the invoices behind it. */
export async function merchantAr(
  merchantId: string,
  asOf?: string,
  opts?: { merchantView?: boolean },
): Promise<{
  merchantId: string;
  outstandingCents: number;
  buckets: Record<AgeingBucket, number>;
  invoices: (InvoiceRow & { outstandingCents: number; daysPastDue: number })[];
  creditNotes: CreditNoteRow[];
}> {
  const day = asOf ?? colomboToday();
  const ageing = await arAgeing({ asOf: day, merchantId });
  const invoices = await db
    .select()
    .from(codInvoice)
    .where(
      and(
        eq(codInvoice.merchantId, merchantId),
        opts?.merchantView ? inArray(codInvoice.status, MERCHANT_VISIBLE_INVOICES) : ne(codInvoice.status, "void"),
      ),
    )
    .orderBy(desc(codInvoice.createdAt));
  const creditNotes = await db
    .select()
    .from(codCreditNote)
    .where(eq(codCreditNote.merchantId, merchantId))
    .orderBy(desc(codCreditNote.issuedAt));

  return {
    merchantId,
    outstandingCents: ageing.outstandingCents,
    buckets: ageing.totals,
    invoices: invoices.map((invoice) => ({
      ...invoice,
      outstandingCents: invoiceOutstanding(invoice),
      daysPastDue:
        invoice.status === "issued" || invoice.status === "part_paid"
          ? Math.max(0, daysBetween(invoice.dueDate, day))
          : 0,
    })),
    creditNotes,
  };
}
