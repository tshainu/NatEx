import { z } from "zod";
import { deskProc, financeProc, moneyReadProc, mutate } from "../middleware/pipeline";
import * as settlement from "../modules/cod/settlement";
import * as invoicing from "../modules/cod/invoicing";
import * as holds from "../modules/cod/holds";
import { errors } from "../shared/errors";
import type { Principal } from "../shared/auth";
import { prefixedId } from "../shared/ulid";

/**
 * Finance routes — Milestone 4 (PROJECT.md §8 checkpoints 4–6, §10 M4).
 * The merchant-facing half of the money module: payout details, the weekly
 * settlement cycle, settlement holds, invoices and AR. The rider-cash half —
 * collections, deposits, banking, reconciliation — is routes/cod.ts, split only
 * to stay under the 500-line lint ceiling.
 *
 * Role split, from §6's role table read against §8:
 *   - everything that moves or promises money is financeProc. Ops is
 *     deliberately excluded from the entire write surface here: ops decides
 *     what happens to parcels, finance decides what happens to money.
 *   - maker–checker on settlement approval is enforced inside
 *     settlement.approveSettlement() by user id, not here. The route layer
 *     does not re-check it — one rule, one place, so the two cannot disagree.
 *   - network-wide aggregates (AR ageing, the settlement-due run) are
 *     deskProc: they are a desk's worklist, not a merchant's statement.
 *   - a merchant reads its own statement, settlements, invoices, holds and AR
 *     through moneyReadProc (never field roles), row-scoped as below.
 *
 * ROW SCOPING — READ THIS BEFORE ADDING A ROUTE HERE.
 * §5 requires a merchant principal to reach only its own rows, and these
 * services do NOT self-scope: `listSettlements`/`listInvoices`/`listHolds` take
 * a merchantId filter and return the whole network without one, and
 * `getSettlement`/`getInvoice` take a bare id with no notion of a caller. So:
 *   - list routes pin the filter with `scopeMerchant()`
 *   - by-id routes read first, then check ownership with `assertOwned()`
 *   - anything that cannot be scoped either way is deskProc/financeProc
 * A merchant naming someone else's merchantId is refused outright rather than
 * silently re-scoped: quietly answering a different question than the one asked
 * is how a caller ends up trusting a filter that does not hold.
 */

/**
 * Resolve the merchantId a read should use. Merchants are pinned to their own;
 * staff get whatever they asked for, including nothing.
 */
function scopeMerchant(principal: Principal, requested?: string): string | undefined {
  if (principal.role !== "merchant") return requested;
  if (!principal.merchantId) errors.forbidden("This account is not linked to a merchant.");
  if (requested && requested !== principal.merchantId) {
    errors.forbidden("A merchant can only read its own finance records.");
  }
  return principal.merchantId ?? undefined;
}

/** Same, for a route where the merchantId is mandatory. */
function requireMerchant(principal: Principal, requested?: string): string {
  const scoped = scopeMerchant(principal, requested);
  if (!scoped) errors.badRequest("A merchant must be named.");
  return scoped!;
}

/** True when the caller is a merchant, so reads drop finance's working state. */
const merchantView = (principal: Principal): boolean => principal.role === "merchant";

/** Ownership check for a row already read by id. */
function assertOwned(principal: Principal, ownerMerchantId: string): void {
  if (principal.role !== "merchant") return;
  if (!principal.merchantId || principal.merchantId !== ownerMerchantId) {
    errors.forbidden("That record belongs to another merchant.");
  }
}

const money = z.number().int().positive();
const settlementStatus = z.enum(["draft", "proposed", "approved", "paid", "rejected", "on_hold"]);
const invoiceStatus = z.enum(invoicing.INVOICE_STATUSES);
const holdScope = z.enum(["parcel", "merchant"]);
const holdReason = z.enum(holds.HOLD_REASONS);
const reason = z.string().min(3).max(500);
/** ISO day. The services take `asOf` and derive the period themselves, so the
 *  route never has to accept a hand-built SettlementPeriod. */
const asOf = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

const deduction = z.object({
  type: z.enum(settlement.MANUAL_DEDUCTION_TYPES),
  amountCents: money.optional(),
  parcelId: z.string().nullish(),
  awb: z.string().nullish(),
  description: z.string().min(1).max(300),
});

const charge = z.object({
  description: z.string().min(1).max(300),
  unitCents: money,
  quantity: z.number().int().positive().max(100000).optional(),
  parcelId: z.string().nullish(),
  awb: z.string().nullish(),
  taxable: z.boolean().optional(),
  recovered: z.boolean().optional(),
});

// ──────────────────────────────────────────────────────── payout details

/** Where a merchant's money goes. A merchant may read its own. */
export const payoutDetails = moneyReadProc
  .input(z.object({ merchantId: z.string().optional() }))
  .handler(({ input, context }) =>
    settlement.getMerchantPayout(requireMerchant(context.principal, input.merchantId)),
  );

/**
 * Set or correct bank details. Finance only, and never the merchant itself:
 * a merchant able to rewrite its own payout account is the whole of §8's
 * fraud surface in one route.
 */
export const setPayoutDetails = financeProc
  .input(
    z.object({
      merchantId: z.string().min(1),
      beneficiaryName: z.string().min(1).max(200),
      bankName: z.string().min(1).max(200),
      branchName: z.string().min(1).max(200),
      accountNumber: z.string().min(1).max(64),
      verified: z.boolean().optional(),
      note: z.string().max(500).nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.setPayoutDetails",
        entity: "cod_merchant_payout",
        entityId: () => input.merchantId,
        action: "cod.payout_details_set",
      },
      () => settlement.setMerchantPayout({ ...input, actor: context.principal }),
    ),
  );

// ─────────────────────────────────────────────────────── settlement cycle

/** The current weekly window and when its payout falls due (§8). */
export const currentPeriod = deskProc
  .input(z.object({ asOf }))
  .handler(({ input }) => settlement.currentPeriod(input.asOf));

/** Every merchant with money accrued in the window — finance's run worklist. */
export const settlementDue = deskProc
  .input(z.object({ asOf }))
  .handler(async ({ input }) =>
    settlement.settlementDue(input.asOf ? await settlement.currentPeriod(input.asOf) : undefined),
  );

/**
 * What a run would pay, without creating one. Finance only: the preview carries
 * network-side deductions and hold reasons a merchant has no business reading
 * before the run is approved.
 */
export const settlementPreview = financeProc
  .input(
    z.object({
      merchantId: z.string().min(1),
      deductions: z.array(deduction).max(200).optional(),
      asOf,
    }),
  )
  .handler(({ input }) => settlement.settlementPreview(input));

/** Live payable balance, to the cent. A merchant may read its own. */
export const payable = moneyReadProc
  .input(z.object({ merchantId: z.string().optional() }))
  .handler(({ input, context }) =>
    settlement.merchantPayableCents(requireMerchant(context.principal, input.merchantId)),
  );

export const settlements = moneyReadProc
  .input(
    z.object({
      merchantId: z.string().optional(),
      status: z.array(settlementStatus).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
  )
  .handler(({ input, context }) =>
    settlement.listSettlements({
      ...input,
      merchantId: scopeMerchant(context.principal, input.merchantId),
      merchantView: merchantView(context.principal),
    }),
  );

/**
 * The settlement register, one server page at a time (§11). Same scoping as
 * `settlements`; a merchant naming another merchant is a 403.
 */
export const settlementPage = moneyReadProc
  .input(
    z.object({
      merchantId: z.string().optional(),
      status: z.array(settlementStatus).optional(),
      q: z.string().trim().max(80).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(200).default(25),
    }),
  )
  .handler(async ({ input, context }) => ({
    ...(await settlement.settlementPage({
      merchantId: scopeMerchant(context.principal, input.merchantId),
      merchantView: merchantView(context.principal),
      status: input.status,
      q: input.q,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    })),
    page: input.page,
    pageSize: input.pageSize,
  }));

/** One run with its lines. Read first, then ownership-checked — see the header. */
export const settlementById = moneyReadProc
  .input(z.object({ settlementId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const found = await settlement.getSettlement(input.settlementId);
    assertOwned(context.principal, found.settlement.merchantId);
    // A merchant's own draft is not a secret, but it is not yet a payout: answer
    // exactly as if it did not exist, the same as the lists do.
    if (merchantView(context.principal) && !settlement.merchantMaySee(found.settlement)) {
      errors.notFound("Settlement");
    }
    return found;
  });

/** §8 checkpoint 4 — the maker builds the run. Draft only; no money moves. */
export const createSettlement = financeProc
  .input(
    z.object({
      merchantId: z.string().min(1),
      deductions: z.array(deduction).max(200).optional(),
      asOf,
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.createSettlement",
        entity: "cod_settlement",
        entityId: (r) => (r as { settlement: { id: string } }).settlement.id,
        action: "cod.settlement_created",
      },
      () => settlement.createSettlement({ ...input, actor: context.principal }),
    ),
  );

export const proposeSettlement = financeProc
  .input(z.object({ settlementId: z.string().min(1) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.proposeSettlement",
        entity: "cod_settlement",
        entityId: () => input.settlementId,
        action: "cod.settlement_proposed",
      },
      () => settlement.proposeSettlement({ ...input, actor: context.principal }),
    ),
  );

/**
 * §8 checkpoint 5 — the checker approves. The service refuses the maker by user
 * id; this route does not repeat that check (see the header's role note).
 */
export const approveSettlement = financeProc
  .input(z.object({ settlementId: z.string().min(1) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.approveSettlement",
        entity: "cod_settlement",
        entityId: () => input.settlementId,
        action: "cod.settlement_approved",
      },
      () => settlement.approveSettlement({ ...input, actor: context.principal }),
    ),
  );

export const rejectSettlement = financeProc
  .input(z.object({ settlementId: z.string().min(1), reason }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.rejectSettlement",
        entity: "cod_settlement",
        entityId: () => input.settlementId,
        action: "cod.settlement_rejected",
      },
      () => settlement.rejectSettlement({ ...input, actor: context.principal }),
    ),
  );

/** Stop a run mid-flight. Separate from a hold on the merchant: this parks one
 *  run, holds.raiseHold() blocks every future one. */
export const holdSettlement = financeProc
  .input(z.object({ settlementId: z.string().min(1), reason }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.holdSettlement",
        entity: "cod_settlement",
        entityId: () => input.settlementId,
        action: "cod.settlement_held",
      },
      () => settlement.holdSettlement({ ...input, actor: context.principal }),
    ),
  );

export const releaseSettlement = financeProc
  .input(z.object({ settlementId: z.string().min(1), note: reason }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.releaseSettlement",
        entity: "cod_settlement",
        entityId: () => input.settlementId,
        action: "cod.settlement_released",
      },
      () => settlement.releaseSettlement({ ...input, actor: context.principal }),
    ),
  );

/**
 * §8 checkpoint 6 — the bank has paid and the UTR is recorded. This is the
 * write that posts SETTLE to the ledger, so it is the last irreversible step
 * of the cycle; a mistake after this needs a dispute, not an edit.
 */
export const recordPayout = financeProc
  .input(z.object({ settlementId: z.string().min(1), utr: z.string().min(1).max(120) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.recordPayout",
        entity: "cod_settlement",
        entityId: () => input.settlementId,
        action: "cod.settlement_paid",
      },
      () => settlement.recordPayout({ ...input, actor: context.principal }),
    ),
  );

/** The bank upload file. A write, not a read: exporting marks the runs exported. */
export const exportPayoutCsv = financeProc
  .input(
    z.object({
      settlementIds: z.array(z.string().min(1)).min(1).max(500),
      force: z.boolean().optional(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.exportPayoutCsv",
        entity: "cod_settlement",
        entityId: () => input.settlementIds[0]!,
        action: "cod.payout_csv_exported",
      },
      () => settlement.exportPayoutCsv({ ...input, actor: context.principal }),
    ),
  );

/** The merchant's own account page: balance, runs, open holds, bank details. */
export const statement = moneyReadProc
  .input(z.object({ merchantId: z.string().optional() }))
  .handler(({ input, context }) =>
    settlement.merchantStatement(requireMerchant(context.principal, input.merchantId), {
      merchantView: merchantView(context.principal),
    }),
  );

// ─────────────────────────────────────────────────────── settlement holds

export const listHolds = moneyReadProc
  .input(
    z.object({
      merchantId: z.string().optional(),
      parcelId: z.string().optional(),
      status: z.array(z.enum(["open", "cleared"])).optional(),
      scope: holdScope.optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
  )
  .handler(({ input, context }) =>
    holds.listHolds({ ...input, merchantId: scopeMerchant(context.principal, input.merchantId) }),
  );

/** The hold register, paged server-side (§11). Scoped like `listHolds`. */
export const holdPage = moneyReadProc
  .input(
    z.object({
      merchantId: z.string().optional(),
      status: z.array(z.enum(["open", "cleared"])).optional(),
      scope: holdScope.optional(),
      reason: z.array(holdReason).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(200).default(25),
    }),
  )
  .handler(async ({ input, context }) => ({
    ...(await holds.holdPage({
      merchantId: scopeMerchant(context.principal, input.merchantId),
      status: input.status,
      scope: input.scope,
      reason: input.reason,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    })),
    page: input.page,
    pageSize: input.pageSize,
  }));

/**
 * Is this merchant clear to be paid? `heldParcelIds` is a Set in the service
 * and is flattened to an array here — oRPC serialises JSON, and a Set crosses
 * the wire as `{}`.
 */
export const holdState = moneyReadProc
  .input(z.object({ merchantId: z.string().optional() }))
  .handler(async ({ input, context }) => {
    const state = await holds.merchantHoldState(requireMerchant(context.principal, input.merchantId));
    return { ...state, heldParcelIds: [...state.heldParcelIds] };
  });

/**
 * Open a hold by hand (§8's `manual` reason). Finance only: a hold stops money
 * leaving, and ops raising one would let the parcel desk freeze payouts.
 * `sourceKey` is the service's dedupe key — callers may pass their own so a
 * retry collapses, and one is generated when they do not.
 */
export const raiseHold = financeProc
  .input(
    z.object({
      scope: holdScope,
      reason: holdReason.default("manual"),
      merchantId: z.string().min(1),
      parcelId: z.string().nullish(),
      awb: z.string().nullish(),
      entryId: z.string().nullish(),
      depositId: z.string().nullish(),
      disputeId: z.string().nullish(),
      amountCents: z.number().int().positive().nullish(),
      detail: z.string().min(3).max(1000),
      sourceKey: z.string().min(1).max(200).optional(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.raiseHold",
        entity: "cod_hold",
        entityId: (r) => (r as { hold: { id: string } }).hold.id,
        action: "cod.hold_raised",
      },
      () =>
        holds.raiseHold({
          ...input,
          sourceKey: input.sourceKey ?? prefixedId("manualhold"),
          actor: context.principal,
        }),
    ),
  );

/** Clearing needs a named human and an explanation — the service enforces both. */
export const clearHold = financeProc
  .input(z.object({ holdId: z.string().min(1), note: reason }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.clearHold",
        entity: "cod_hold",
        entityId: () => input.holdId,
        action: "cod.hold_cleared",
      },
      () => holds.clearHold({ ...input, actor: context.principal }),
    ),
  );

// ─────────────────────────────────────────────────────── invoices and AR

export const invoices = moneyReadProc
  .input(
    z.object({
      merchantId: z.string().optional(),
      status: z.array(invoiceStatus).optional(),
      overdueOnly: z.boolean().optional(),
      asOf,
      limit: z.number().int().min(1).max(200).default(50),
    }),
  )
  .handler(({ input, context }) =>
    invoicing.listInvoices({
      ...input,
      merchantId: scopeMerchant(context.principal, input.merchantId),
      merchantView: merchantView(context.principal),
    }),
  );

/** The invoice register, paged server-side (§11). Scoped like `invoices`. */
export const invoicePage = moneyReadProc
  .input(
    z.object({
      merchantId: z.string().optional(),
      status: z.array(invoiceStatus).optional(),
      overdueOnly: z.boolean().optional(),
      q: z.string().trim().max(80).optional(),
      asOf,
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(200).default(25),
    }),
  )
  .handler(async ({ input, context }) => ({
    ...(await invoicing.invoicePage({
      merchantId: scopeMerchant(context.principal, input.merchantId),
      merchantView: merchantView(context.principal),
      status: input.status,
      overdueOnly: input.overdueOnly,
      q: input.q,
      asOf: input.asOf,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    })),
    page: input.page,
    pageSize: input.pageSize,
  }));

export const invoiceById = moneyReadProc
  .input(z.object({ invoiceId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const found = await invoicing.getInvoice(input.invoiceId);
    assertOwned(context.principal, found.invoice.merchantId);
    if (merchantView(context.principal) && !invoicing.MERCHANT_VISIBLE_INVOICES.includes(found.invoice.status as invoicing.InvoiceStatus)) {
      errors.notFound("Invoice");
    }
    return found;
  });

/** What this period's invoice would say, before anything is billed. */
export const invoicePreview = financeProc
  .input(
    z.object({
      merchantId: z.string().min(1),
      charges: z.array(charge).max(500).optional(),
      asOf,
    }),
  )
  .handler(({ input }) => invoicing.invoicePreview(input));

export const createInvoice = financeProc
  .input(
    z.object({
      merchantId: z.string().min(1),
      charges: z.array(charge).max(500).optional(),
      asOf,
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.createInvoice",
        entity: "cod_invoice",
        entityId: (r) => (r as { invoice: { id: string } }).invoice.id,
        action: "cod.invoice_created",
      },
      () => invoicing.createInvoice({ ...input, actor: context.principal }),
    ),
  );

/** Draft → issued: the point the merchant owes it and the clock starts. */
export const issueInvoice = financeProc
  .input(z.object({ invoiceId: z.string().min(1), asOf }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.issueInvoice",
        entity: "cod_invoice",
        entityId: () => input.invoiceId,
        action: "cod.invoice_issued",
      },
      () => invoicing.issueInvoice({ ...input, actor: context.principal }),
    ),
  );

export const recordInvoicePayment = financeProc
  .input(
    z.object({
      invoiceId: z.string().min(1),
      amountCents: money,
      reference: z.string().min(1).max(120),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.recordInvoicePayment",
        entity: "cod_invoice",
        entityId: () => input.invoiceId,
        action: "cod.invoice_payment_recorded",
      },
      () => invoicing.recordInvoicePayment({ ...input, actor: context.principal }),
    ),
  );

/** An issued invoice is never edited (§11) — it is credited. */
export const issueCreditNote = financeProc
  .input(
    z.object({
      invoiceId: z.string().min(1),
      amountCents: money,
      reason,
      disputeId: z.string().nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.issueCreditNote",
        entity: "cod_credit_note",
        entityId: (r) => (r as { creditNote: { id: string } }).creditNote.id,
        action: "cod.credit_note_issued",
      },
      () => invoicing.issueCreditNote({ ...input, actor: context.principal }),
    ),
  );

/** Only a draft that should never have existed. Anything issued gets credited. */
export const voidInvoice = financeProc
  .input(z.object({ invoiceId: z.string().min(1), reason }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "finance.voidInvoice",
        entity: "cod_invoice",
        entityId: () => input.invoiceId,
        action: "cod.invoice_voided",
      },
      () => invoicing.voidInvoice({ ...input, actor: context.principal }),
    ),
  );

/** Network-wide AR ageing — a finance desk report, so staff only. */
export const arAgeing = deskProc
  .input(z.object({ merchantId: z.string().optional(), asOf }))
  .handler(({ input }) => invoicing.arAgeing(input));

/** The same numbers for one merchant, which a merchant may read for itself. */
export const merchantAr = moneyReadProc
  .input(z.object({ merchantId: z.string().optional(), asOf }))
  .handler(({ input, context }) =>
    invoicing.merchantAr(requireMerchant(context.principal, input.merchantId), input.asOf, {
      merchantView: merchantView(context.principal),
    }),
  );

/** Router namespace — composed into the root router in api/index.ts. */
export const finance = {
  payoutDetails,
  setPayoutDetails,
  currentPeriod,
  settlementDue,
  settlementPreview,
  payable,
  settlements,
  settlementPage,
  settlementById,
  createSettlement,
  proposeSettlement,
  approveSettlement,
  rejectSettlement,
  holdSettlement,
  releaseSettlement,
  recordPayout,
  exportPayoutCsv,
  statement,
  listHolds,
  holdPage,
  holdState,
  raiseHold,
  clearHold,
  invoices,
  invoicePage,
  invoiceById,
  invoicePreview,
  createInvoice,
  issueInvoice,
  recordInvoicePayment,
  issueCreditNote,
  voidInvoice,
  arAgeing,
  merchantAr,
};
