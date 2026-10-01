import { sqliteTable, text, integer, index, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * MODULE: cod — the money module (PROJECT.md §8, §10 M4).
 *
 * PROJECT.md §4: only modules/cod/* reads these tables. Parcels, merchants and
 * riders are reached through their own module services, never selected here.
 *
 * NON-NEGOTIABLE (§1, §8): "No cash-on-delivery amount may be untraceable.
 * Every COD rupee is recorded in an append-only, double-entry ledger and
 * reconciled at four checkpoints."
 *
 * Two rules shape every table below:
 *
 *   1. APPEND-ONLY. `cod_entry` has no UPDATE and no DELETE path anywhere in
 *      the codebase (§11: "Append-only tables (parcel_event, cod_entry,
 *      audit_log) have no UPDATE or DELETE path"). A correction is a new
 *      reversal row pointing at the original via `reversal_of_id`.
 *   2. MONEY IS INTEGER CENTS (§9: "Never use float or double for money").
 *      Every monetary column below is `integer(...Cents)`. There is no
 *      `real`/`numeric` column in this file, deliberately.
 *
 * The document headers (deposit, settlement, invoice, dispute) ARE mutable —
 * they carry workflow state. The ledger underneath them is not. That split is
 * intentional: a settlement can move draft → proposed → approved → paid, but
 * the rupees it moved are immutable rows.
 */

// ─────────────────────────────────────────────────────────────── the ledger

/**
 * The double-entry ledger. One row = one movement of money between two
 * accounts (see modules/cod/accounts.ts for the chart of accounts).
 *
 * §8's five checkpoints map onto `type`:
 *   COLLECT  rider takes cash from the consignee
 *   DEPOSIT  rider hands cash to a branch/hub
 *   BANK     branch verifies and banks it
 *   SETTLE   finance pays a merchant out
 *   FEE      a deduction NatEx keeps (COD fee, RTO fee, …)
 *   VARIANCE a counted-vs-declared shortfall or excess, named not hidden
 *   REVERSAL a correction referencing the row it reverses
 *
 * Both legs live on one row (`debit_account` / `credit_account`) rather than as
 * two rows. With one writer and an immutable table this cannot half-post, and
 * it makes the balance query a single scan. `modules/cod/accounts.ts` proves
 * the whole ledger sums to zero, which is the property a two-row model is
 * usually chosen to guarantee.
 */
export const codEntry = sqliteTable(
  "cod_entry",
  {
    id: text("id").primaryKey(),
    /**
     * Monotonic human-facing sequence, assigned per entry. Auditors ask "show
     * me entry 4,812", and a ULID is unreadable over the phone.
     */
    seq: integer("seq").notNull(),
    /** `CodEntryType` from `modules/cod/accounts.ts` — the domain owns the vocabulary. */
    type: text("type").notNull(),

    /** MONEY: integer cents, LKR (§9). Always positive — direction lives in the accounts. */
    amountCents: integer("amount_cents").notNull(),
    debitAccount: text("debit_account").notNull(),
    creditAccount: text("credit_account").notNull(),

    /** cash | bank | adjustment — how the money physically moved. */
    mode: text("mode").notNull().default("cash"),
    /** Gateway/bank/slip reference, verbatim from whoever supplied it. */
    ref: text("ref"),

    // Dimensions. Nullable because not every entry has every dimension: a
    // COLLECT has a parcel, a BANK has only a branch and a bank reference.
    parcelId: text("parcel_id"),
    awb: text("awb"),
    merchantId: text("merchant_id"),
    riderId: text("rider_id"),
    branchId: text("branch_id"),
    depositId: text("deposit_id"),
    settlementId: text("settlement_id"),

    /** The entry this one corrects. Set only on type=REVERSAL. */
    reversalOfId: text("reversal_of_id"),
    /** Set on the original once reversed, so a reader sees it at a glance. */
    reversedById: text("reversed_by_id"),

    note: text("note"),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    actorRole: text("actor_role"),
    /**
     * Client-minted id for offline-first idempotency (§7). A rider's phone
     * retrying a delivery must not double-count the cash (§4: "Omitting this
     * causes silent double-counted COD collections").
     */
    clientId: text("client_id"),
    ts: integer("ts", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("cod_entry_type_idx").on(t.type),
    index("cod_entry_parcel_idx").on(t.parcelId),
    index("cod_entry_rider_idx").on(t.riderId),
    index("cod_entry_merchant_idx").on(t.merchantId),
    index("cod_entry_deposit_idx").on(t.depositId),
    index("cod_entry_settlement_idx").on(t.settlementId),
    index("cod_entry_debit_idx").on(t.debitAccount),
    index("cod_entry_credit_idx").on(t.creditAccount),
    index("cod_entry_seq_idx").on(t.seq),
    /**
     * §7's conflict policy, enforced by the database rather than by a check:
     * "COD collected twice for one parcel — second entry rejected". One
     * COLLECT per parcel, forever.
     */
    unique("cod_entry_one_collect_per_parcel").on(t.type, t.parcelId),
    /** A retried offline operation lands exactly once (§7). */
    unique("cod_entry_client_id").on(t.clientId),
  ],
);

// ────────────────────────────────────────────────────── checkpoint 2 and 3

/**
 * A rider handing cash over at a branch (§8 checkpoint 2), and the branch
 * counting and banking it (checkpoint 3).
 *
 * Three amounts, deliberately kept apart so §219's "variance highlighted at
 * each stage" has something to highlight:
 *
 * - `expectedCents` — the sum of the COLLECT entries named on this deposit.
 *   The ledger's baseline: this is what the rider is relieved of.
 * - `declaredCents` — what the rider says is in the bag.
 * - `countedCents`  — what the cashier actually counts. This is what enters the
 *   safe, so it is what gets banked.
 *
 * They are never reconciled silently. `countedCents − expectedCents` is the
 * difference that has to go somewhere in a double-entry book, so it becomes the
 * VARIANCE entry; `countedCents − declaredCents` is the rider's own miscount,
 * which needs an explanation but moves no money on its own. Either gap blocks
 * the merchant's payout until someone explains it (§8 "Settlement hold").
 */
export const codDeposit = sqliteTable(
  "cod_deposit",
  {
    id: text("id").primaryKey(),
    /** Read out over a counter: DEP260930-0001. */
    code: text("code").notNull().unique(),
    riderId: text("rider_id").notNull(),
    riderName: text("rider_name").notNull(),
    /** Branch receiving the cash — row-level scoping (§5). */
    branchId: text("branch_id").notNull(),
    /** Asia/Colombo calendar day (§9), not a UTC instant. */
    depositDate: text("deposit_date").notNull(),

    /** MONEY: cents. Σ of the COLLECT entries on this deposit — the ledger baseline. */
    expectedCents: integer("expected_cents").notNull().default(0),
    /** MONEY: cents. What the rider declared at the counter. */
    declaredCents: integer("declared_cents").notNull(),
    /** MONEY: cents. What the cashier counted. Null until verified. */
    countedCents: integer("counted_cents"),
    /** MONEY: cents. counted − expected. The gap the VARIANCE entry carries. Negative = short. */
    varianceCents: integer("variance_cents"),
    /** MONEY: cents. counted − declared. The rider's own miscount; moves no money. */
    declaredVarianceCents: integer("declared_variance_cents"),

    /** declared | verified | banked | rejected */
    status: text("status").notNull().default("declared"),
    /** Free text the cashier must supply when the count does not match. */
    varianceReason: text("variance_reason"),

    /** Bank deposit slip / transfer reference (checkpoint 3). */
    bankRef: text("bank_ref"),
    bankAccount: text("bank_account"),
    bankedAt: integer("banked_at", { mode: "timestamp" }),

    verifiedById: text("verified_by_id"),
    verifiedByName: text("verified_by_name"),
    verifiedAt: integer("verified_at", { mode: "timestamp" }),

    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdByName: text("created_by_name"),
  },
  (t) => [
    index("cod_deposit_rider_idx").on(t.riderId),
    index("cod_deposit_branch_idx").on(t.branchId),
    index("cod_deposit_status_idx").on(t.status),
    index("cod_deposit_date_idx").on(t.depositDate),
  ],
);

/**
 * Which collections a deposit covers. Without this join the four-way
 * reconciliation cannot say *which* parcels' cash is still in a rider's pocket,
 * only how much — and "how much" is not enough to chase it.
 */
export const codDepositItem = sqliteTable(
  "cod_deposit_item",
  {
    id: text("id").primaryKey(),
    depositId: text("deposit_id").notNull(),
    /** The COLLECT entry being deposited. */
    entryId: text("entry_id").notNull(),
    parcelId: text("parcel_id").notNull(),
    awb: text("awb").notNull(),
    amountCents: integer("amount_cents").notNull(),
  },
  (t) => [
    index("cod_deposit_item_deposit_idx").on(t.depositId),
    /** A collection can only be deposited once. */
    unique("cod_deposit_item_entry").on(t.entryId),
  ],
);

// ──────────────────────────────────────────────────────────── checkpoint 4

/**
 * A merchant settlement run (§8 checkpoint 4). "Settlement is a proposal until
 * approved — maker–checker: the creator cannot approve their own run."
 *
 * Cycle per the client's answer to §15 q4: weekly, Friday cut-off, payout the
 * following Wednesday. Both dates are stored per-run rather than recomputed,
 * because a rule change must not silently restate history.
 */
export const codSettlement = sqliteTable(
  "cod_settlement",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    merchantId: text("merchant_id").notNull(),
    merchantName: text("merchant_name").notNull(),

    /** Inclusive Asia/Colombo calendar range this run covers. */
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    /** When the money is due to leave — Wednesday after the Friday cut-off. */
    payoutDate: text("payout_date").notNull(),

    /** MONEY: cents. COD banked on the merchant's behalf. */
    grossCents: integer("gross_cents").notNull().default(0),
    /** MONEY: cents, positive. Sum of every deduction line. */
    deductionsCents: integer("deductions_cents").notNull().default(0),
    /** MONEY: cents. gross − deductions. What actually gets paid. */
    netCents: integer("net_cents").notNull().default(0),

    /** draft | proposed | approved | paid | rejected | on_hold */
    status: text("status").notNull().default("draft"),
    /**
     * Why this run cannot move (§8 "Any open variance blocks that merchant's
     * payout"). Non-null means the payout is stopped.
     */
    holdReason: text("hold_reason"),

    // Maker–checker (§8). Two different humans, enforced in the service and
    // visible here forever.
    createdById: text("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    proposedAt: integer("proposed_at", { mode: "timestamp" }),
    approvedById: text("approved_by_id"),
    approvedByName: text("approved_by_name"),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    rejectedReason: text("rejected_reason"),

    /** Bank's unique transaction reference, recorded once paid (§8 step 5). */
    utr: text("utr"),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    /** Set when the payout CSV is generated, so a run is not exported twice by accident. */
    exportedAt: integer("exported_at", { mode: "timestamp" }),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("cod_settlement_merchant_idx").on(t.merchantId),
    index("cod_settlement_status_idx").on(t.status),
    index("cod_settlement_period_idx").on(t.periodStart, t.periodEnd),
    /**
     * At most one OPEN run per merchant per period.
     *
     * Partial on purpose. A merchant banks cash several times inside one
     * Sat–Fri week, so a period that has already been paid must still accept a
     * supplementary run for money banked afterwards — otherwise those rupees
     * are stranded until the next cut-off, which §8 forbids. What actually
     * stops a parcel being paid twice is the entry-level claim
     * (`claimedEntryIds()`); this index only stops two runs being open at once.
     */
    uniqueIndex("cod_settlement_open_per_period")
      .on(t.merchantId, t.periodStart, t.periodEnd)
      .where(sql`status in ('draft', 'proposed', 'approved', 'on_hold')`),
  ],
);

/**
 * The line items of a run. §8: "Deductions modelled explicitly: COD fee,
 * forwarding, RTO fee, weight discrepancy, penalties, withholding tax."
 *
 * `amountCents` is SIGNED: positive credits the merchant (COD collected),
 * negative deducts. The header's gross/deductions/net are derived from these
 * rows and asserted against them, so a header can never drift from its lines.
 */
export const codSettlementLine = sqliteTable(
  "cod_settlement_line",
  {
    id: text("id").primaryKey(),
    settlementId: text("settlement_id").notNull(),
    /**
     * cod_collected | cod_fee | rto_fee | forwarding | weight_discrepancy
     * | penalty | withholding_tax | adjustment
     */
    type: text("type").notNull(),
    parcelId: text("parcel_id"),
    awb: text("awb"),
    /** MONEY: cents, SIGNED. Positive = payable to merchant, negative = deduction. */
    amountCents: integer("amount_cents").notNull(),
    description: text("description").notNull(),
    /** The ledger entry this line was derived from, where there is one. */
    entryId: text("entry_id"),
  },
  (t) => [
    index("cod_settlement_line_settlement_idx").on(t.settlementId),
    index("cod_settlement_line_type_idx").on(t.type),
    index("cod_settlement_line_parcel_idx").on(t.parcelId),
  ],
);

/**
 * A block on money leaving (§8's controls table): "Amount mismatch → parcel
 * held from settlement" and "Settlement hold → any open variance blocks that
 * merchant's payout".
 *
 * This table exists because those two controls need state a settlement run can
 * *query*. Before it, a mismatch only enqueued an outbox event — which tells
 * ops something happened but leaves nothing for `settlement.ts` to check, so a
 * held parcel would have been paid out anyway.
 *
 * Holds are mutable workflow state, not ledger rows: they open, and someone
 * with a name clears them with an explanation. The rupees stay in `cod_entry`
 * either way — a hold delays a payout, it never alters what was collected.
 *
 * `sourceKey` makes raising a hold idempotent: one amount-mismatch hold per
 * parcel, one deposit-variance hold per parcel per deposit, however many times
 * an offline retry replays the event.
 */
export const codHold = sqliteTable(
  "cod_hold",
  {
    id: text("id").primaryKey(),
    /** parcel — blocks that parcel's line. merchant — blocks the whole payout. */
    scope: text("scope").notNull(),
    /** amount_mismatch | deposit_variance | dispute | manual */
    reason: text("reason").notNull(),
    /** open | cleared */
    status: text("status").notNull().default("open"),

    merchantId: text("merchant_id"),
    parcelId: text("parcel_id"),
    awb: text("awb"),
    /** The ledger entry, deposit or dispute that caused it, where there is one. */
    entryId: text("entry_id"),
    depositId: text("deposit_id"),
    disputeId: text("dispute_id"),
    /** MONEY: cents. The disputed or missing amount, when quantifiable. */
    amountCents: integer("amount_cents"),
    detail: text("detail").notNull(),

    /** `${reason}:${parcel|deposit|merchant id}` — dedupes replayed events. */
    sourceKey: text("source_key").notNull(),

    openedAt: integer("opened_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    openedById: text("opened_by_id"),
    openedByName: text("opened_by_name"),
    clearedAt: integer("cleared_at", { mode: "timestamp" }),
    clearedById: text("cleared_by_id"),
    clearedByName: text("cleared_by_name"),
    /** Why it was safe to release. Required — a hold is never cleared silently. */
    clearedNote: text("cleared_note"),
  },
  (t) => [
    index("cod_hold_merchant_idx").on(t.merchantId),
    index("cod_hold_parcel_idx").on(t.parcelId),
    index("cod_hold_status_idx").on(t.status),
    unique("cod_hold_source_key").on(t.sourceKey),
  ],
);

/**
 * Where a merchant's payout is sent.
 *
 * Lives here rather than on `merchants_merchant` on purpose: §4 gives each
 * module its own tables, and bank beneficiary details are finance data that
 * only the settlement code and the finance portal may read. The merchants
 * module has no business selecting an account number.
 *
 * A run cannot be exported to the payout file without a row here — the CSV the
 * client asked for (beneficiary, account, branch, amount, reference) has no
 * other source for its first three columns.
 */
export const codMerchantPayout = sqliteTable("cod_merchant_payout", {
  merchantId: text("merchant_id").primaryKey(),
  /** Account holder's name exactly as the bank has it — mismatches bounce payouts. */
  beneficiaryName: text("beneficiary_name").notNull(),
  bankName: text("bank_name").notNull(),
  branchName: text("branch_name").notNull(),
  accountNumber: text("account_number").notNull(),
  /** Whether finance has confirmed these details against a bank document. */
  verified: integer("verified", { mode: "boolean" }).notNull().default(false),
  note: text("note"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedByName: text("updated_by_name"),
});

// ──────────────────────────────────────────────────────── invoicing and AR

/**
 * Freight invoices to merchants (§10 M4 "Invoicing with VAT/SSCL, credit
 * notes, AR ageing").
 *
 * TAX IS MODELLED BUT INACTIVE. The client's answer to §15 q10 was explicitly
 * "no tax lines until NatEx's VAT/SSCL registration status is confirmed", so
 * `cod_finance_config` seeds vat_active=0 and sscl_active=0 and both columns
 * below compute to 0. The arithmetic is implemented and tested (§9's stacking:
 * SSCL on the charge, then VAT on charge+SSCL) so switching it on is a config
 * change, not a code change. THIS IS AN OPEN QUESTION, NOT A DECISION.
 */
export const codInvoice = sqliteTable(
  "cod_invoice",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    merchantId: text("merchant_id").notNull(),
    merchantName: text("merchant_name").notNull(),
    /** Merchant's VAT registration, copied at issue time — it can change later. */
    merchantVatNo: text("merchant_vat_no"),

    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    /** Net 14 from issue, per the client's answer to §15 q5. */
    dueDate: text("due_date").notNull(),

    /** MONEY: cents. Sum of the taxable and non-taxable lines. */
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    /** MONEY: cents. 2.5% of liable turnover when active (§9). Currently 0. */
    ssclCents: integer("sscl_cents").notNull().default(0),
    /** MONEY: cents. 18% of (subtotal + SSCL) when active (§9). Currently 0. */
    vatCents: integer("vat_cents").notNull().default(0),
    /** MONEY: cents. subtotal + sscl + vat. */
    totalCents: integer("total_cents").notNull().default(0),
    /** MONEY: cents. Settled against this invoice so far. */
    paidCents: integer("paid_cents").notNull().default(0),
    /** MONEY: cents. Credit notes raised against this invoice. */
    creditedCents: integer("credited_cents").notNull().default(0),
    /**
     * MONEY: cents. Charges on this invoice that NatEx already kept out of a
     * COD payout, so the merchant never owes them in cash.
     *
     * Held apart from `paidCents` because the two are different facts with
     * different evidence: a payment has a bank reference and a date, a
     * recovery has a settlement. AR ageing must not chase either, and an
     * auditor asking "how much of this invoice was netted off rather than
     * received?" should not have to infer it.
     */
    recoveredCents: integer("recovered_cents").notNull().default(0),

    /** draft | issued | part_paid | paid | void */
    status: text("status").notNull().default("draft"),
    issuedAt: integer("issued_at", { mode: "timestamp" }),
    voidReason: text("void_reason"),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdByName: text("created_by_name"),
  },
  (t) => [
    index("cod_invoice_merchant_idx").on(t.merchantId),
    index("cod_invoice_status_idx").on(t.status),
    index("cod_invoice_due_idx").on(t.dueDate),
    /**
     * One live invoice per merchant per period — but a VOIDED one releases its
     * slot, so a mistake can be reissued. A plain unique index across every
     * status would strand the period forever after one bad invoice, which is
     * exactly the bug that had to be fixed on `cod_settlement`.
     */
    uniqueIndex("cod_invoice_live_per_period")
      .on(t.merchantId, t.periodStart, t.periodEnd)
      .where(sql`status <> 'void'`),
  ],
);

export const codInvoiceLine = sqliteTable(
  "cod_invoice_line",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id").notNull(),
    description: text("description").notNull(),
    parcelId: text("parcel_id"),
    awb: text("awb"),
    quantity: integer("quantity").notNull().default(1),
    /** MONEY: cents per unit. */
    unitCents: integer("unit_cents").notNull(),
    /** MONEY: cents. quantity × unitCents. */
    amountCents: integer("amount_cents").notNull(),
    /** Whether this line enters the SSCL/VAT base when tax is switched on. */
    taxable: integer("taxable", { mode: "boolean" }).notNull().default(true),
    /**
     * The settlement line this charge was taken from, when it came from one.
     *
     * A charge NatEx already deducted from a COD payout must appear on the tax
     * invoice — that is what makes the invoice a tax document — but it must
     * never be billed twice. This is the same defence `claimedEntryIds()`
     * gives a settlement run, at the row level.
     */
    sourceId: text("source_id"),
    /**
     * Whether the money was already kept out of a COD payout. A recovered line
     * is billed but not chased; see `cod_invoice.recovered_cents`.
     */
    recovered: integer("recovered", { mode: "boolean" }).notNull().default(false),
    /**
     * Mirrors the parent invoice's void status onto the line.
     *
     * Denormalised deliberately. The rule is "a settlement deduction is billed
     * on at most one LIVE invoice", and a SQLite partial index can only see
     * columns of its own table — it cannot read `cod_invoice.status`. Without
     * this column the index would strand a charge on a voided invoice forever,
     * which is the same bug the partial index on `cod_invoice` fixes one level
     * up. Set by `voidInvoice()`, never by a caller.
     */
    voided: integer("voided", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    index("cod_invoice_line_invoice_idx").on(t.invoiceId),
    /**
     * A settlement line can be billed on at most one LIVE invoice. Voiding an
     * invoice releases its charges so the period can be re-invoiced, while the
     * voided document keeps its lines and their source ids intact.
     */
    uniqueIndex("cod_invoice_line_source_key")
      .on(t.sourceId)
      .where(sql`source_id is not null and voided = 0`),
  ],
);

/**
 * A credit note — the only way to reduce an issued invoice. Invoices are never
 * edited after issue for the same reason ledger entries are not: someone
 * downstream has already acted on the number.
 */
export const codCreditNote = sqliteTable(
  "cod_credit_note",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    invoiceId: text("invoice_id").notNull(),
    merchantId: text("merchant_id").notNull(),
    /** MONEY: cents, positive. Reduces what the merchant owes. */
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    /** The dispute that justified it, when it came from one. */
    disputeId: text("dispute_id"),
    issuedById: text("issued_by_id").notNull(),
    issuedByName: text("issued_by_name").notNull(),
    issuedAt: integer("issued_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("cod_credit_note_invoice_idx").on(t.invoiceId),
    index("cod_credit_note_merchant_idx").on(t.merchantId),
  ],
);

// ──────────────────────────────────────────────── disputes and claims (§10)

/**
 * The dispute queue and claim register (§10 M4). A merchant raises a claim, a
 * finance user investigates, and the resolution either credits the merchant
 * (via a credit note) or is rejected with a reason. Every state change is
 * audited; nothing is resolved without text explaining why.
 */
export const codDispute = sqliteTable(
  "cod_dispute",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    merchantId: text("merchant_id").notNull(),
    merchantName: text("merchant_name").notNull(),
    parcelId: text("parcel_id"),
    awb: text("awb"),
    /** cod_shortfall | damage | loss | billing | sla | other */
    type: text("type").notNull(),
    /** MONEY: cents. What the merchant is claiming. */
    claimAmountCents: integer("claim_amount_cents").notNull().default(0),
    /** MONEY: cents. What finance agreed to. */
    approvedAmountCents: integer("approved_amount_cents"),

    /** open | investigating | resolved | rejected | withdrawn */
    status: text("status").notNull().default("open"),
    description: text("description").notNull(),
    resolution: text("resolution"),
    /** Credit note raised to honour the claim, when one was. */
    creditNoteId: text("credit_note_id"),
    /**
     * Snapshots taken when the dispute is opened, so a later edit to the parcel
     * cannot move the cap a claim was judged against. MONEY: cents.
     *   declaredValueCents — the liability ceiling for loss/damage claims
     *   codAmountCents     — the ceiling for a COD shortfall
     */
    declaredValueCents: integer("declared_value_cents"),
    codAmountCents: integer("cod_amount_cents"),
    /** How an upheld claim was paid: credit_note | bank_transfer | none */
    remedy: text("remedy"),
    /** The invoice a credit note was raised against. */
    invoiceId: text("invoice_id"),
    /** Bank transfer reference (UTR) when the remedy is a direct payment. */
    payoutRef: text("payout_ref"),
    /** The settlement hold this dispute raised, if it touched a payout. */
    holdId: text("hold_id"),
    updatedAt: integer("updated_at", { mode: "timestamp" }),

    /** SLA clock, so a claim cannot sit unanswered indefinitely. */
    slaDueAt: integer("sla_due_at", { mode: "timestamp" }),
    openedById: text("opened_by_id").notNull(),
    openedByName: text("opened_by_name").notNull(),
    openedByRole: text("opened_by_role").notNull(),
    assignedToId: text("assigned_to_id"),
    assignedToName: text("assigned_to_name"),
    resolvedById: text("resolved_by_id"),
    resolvedByName: text("resolved_by_name"),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("cod_dispute_merchant_idx").on(t.merchantId),
    index("cod_dispute_status_idx").on(t.status),
    index("cod_dispute_parcel_idx").on(t.parcelId),
  ],
);

// ────────────────────────────────────────────── configuration and the nightly job

/**
 * Finance rates and control thresholds as DATA, not constants.
 *
 * Every number the client gave in answer to §15 lands here rather than in
 * code, because all of them are explicitly provisional: the COD fee is zero
 * only because it is bundled today, the RTO fee is zero only for the promo
 * period, and the tax flags are off only until registration is confirmed. M5's
 * admin portal edits these rows; nothing needs a deploy to change a rate.
 *
 * Values are integer cents or basis points (1 bp = 0.01%), never floats (§9).
 */
export const codFinanceConfig = sqliteTable("cod_finance_config", {
  key: text("key").primaryKey(),
  /** Integer, interpreted per `unit`. */
  value: integer("value").notNull(),
  /** cents | basis_points | hours | days | boolean | count */
  unit: text("unit").notNull(),
  description: text("description").notNull(),
  /** Why it currently holds this value — read by the finance portal. */
  note: text("note"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedByName: text("updated_by_name"),
});

/**
 * Nightly balance-invariant job results (§8: "Checked nightly by a job. A
 * negative balance is impossible by design and must trigger immediate
 * investigation." / §10 M4 "Nightly balance-invariant job").
 *
 * Runs are stored rather than merely logged so that "the invariant held every
 * night last quarter" is a query an auditor can run, not a claim.
 */
export const codInvariantRun = sqliteTable(
  "cod_invariant_run",
  {
    id: text("id").primaryKey(),
    /** Asia/Colombo calendar day the run covers. */
    runDate: text("run_date").notNull(),
    /** ok | breached */
    result: text("result").notNull(),
    ridersChecked: integer("riders_checked").notNull().default(0),
    /** How many separate invariant violations were found. 0 is the only good answer. */
    breachCount: integer("breach_count").notNull().default(0),
    /** MONEY: cents. Total cash riders are holding, across the network. */
    riderLiabilityCents: integer("rider_liability_cents").notNull().default(0),
    /** MONEY: cents. Ledger-wide sum of every account. MUST be 0. */
    ledgerSumCents: integer("ledger_sum_cents").notNull().default(0),
    /** Full findings, including each breach and each stale collection. */
    detailsJson: text("details_json"),
    /**
     * scheduled — the nightly job (jobs/nightly.ts); manual — a finance user
     * pressed "run now". Only a scheduled row satisfies the nightly schedule.
     */
    trigger: text("trigger").notNull().default("manual"),
    ranAt: integer("ran_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("cod_invariant_run_date_idx").on(t.runDate)],
);

// ────────────────────────────────────────────────────── ops / finance alerts

/**
 * Durable escalations from the money module (§8's controls table, §4's outbox).
 *
 * WHY THIS TABLE EXISTS. Every control in §8 ends with a phrase like "ops
 * notified" or "escalated to finance", and the code raised those as outbox
 * topics (`cod.ceiling_breached`, `cod.stale_collection`, …). An outbox row is
 * a *job*, not a record: once drained it is deleted or archived, and a topic
 * with no handler dead-letters silently after five attempts — which is exactly
 * what was happening. Holds (`cod_hold`) cover the two controls that must block
 * money, but a rider crossing the cash ceiling blocks dispatch, not a payout,
 * and a nightly invariant breach blocks nothing at all. Neither had anywhere to
 * live.
 *
 * So: the outbox stays the transport, and this is the destination. One row per
 * distinct escalation, deduped by `source_key` exactly as `cod_hold` is, with a
 * human workflow on top (open → acknowledged → resolved) so an unattended
 * alert is a query rather than a lost log line.
 *
 * DESIGN INFERENCE, NOT A CLIENT INSTRUCTION. §8 says ops must be notified; it
 * does not say by what mechanism, and §15 contains no question about alert
 * routing. This models the notification as a durable queue a human works,
 * because that is the only version of "notified" that survives a restart. If
 * the client wants these pushed to a channel (SMS/WhatsApp to a duty officer)
 * that hangs off this table without changing any caller.
 */
export const codOpsAlert = sqliteTable(
  "cod_ops_alert",
  {
    id: text("id").primaryKey(),
    /** The outbox topic that produced it, verbatim — e.g. `cod.ceiling_breached`. */
    topic: text("topic").notNull(),
    /**
     * amount_mismatch | ceiling_breached | deposit_variance | stale_collection |
     * invariant_breached | settlement_approved | settlement_paid | dispute_opened
     */
    kind: text("kind").notNull(),
    /** low | medium | high — high means money is already at risk. */
    severity: text("severity").notNull().default("medium"),
    /** ops | finance — which desk owns it. */
    audience: text("audience").notNull().default("ops"),
    /**
     * Whether a human must do something. False for the informational ones
     * (a settlement that paid correctly is news, not work), which is what
     * separates the ops worklist from the finance activity feed.
     */
    actionRequired: integer("action_required", { mode: "boolean" }).notNull().default(true),

    riderId: text("rider_id"),
    merchantId: text("merchant_id"),
    parcelId: text("parcel_id"),
    awb: text("awb"),
    entryId: text("entry_id"),
    depositId: text("deposit_id"),
    settlementId: text("settlement_id"),
    disputeId: text("dispute_id"),
    invariantRunId: text("invariant_run_id"),
    /** MONEY: cents. The amount at stake, where the event quantifies one. */
    amountCents: integer("amount_cents"),

    /** One line a human can act on without opening the payload. */
    summary: text("summary").notNull(),
    /** The outbox payload verbatim, so nothing the detector knew is lost. */
    payloadJson: text("payload_json"),

    /**
     * Dedupe key, same contract as `cod_hold.source_key`: the same key twice is
     * the same escalation. Time-bounded for the recurring detectors (the
     * nightly job re-reports every stale collection every night, and a rider
     * over the ceiling breaches again on every scan) so one real problem is one
     * row per day rather than one row per detection.
     */
    sourceKey: text("source_key").notNull(),

    /** open | acknowledged | resolved */
    status: text("status").notNull().default("open"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    acknowledgedAt: integer("acknowledged_at", { mode: "timestamp" }),
    acknowledgedById: text("acknowledged_by_id"),
    acknowledgedByName: text("acknowledged_by_name"),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    resolvedById: text("resolved_by_id"),
    resolvedByName: text("resolved_by_name"),
    /** Why it was safe to close. Required to resolve — never closed silently. */
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    index("cod_ops_alert_status_idx").on(t.status),
    index("cod_ops_alert_kind_idx").on(t.kind),
    index("cod_ops_alert_rider_idx").on(t.riderId),
    index("cod_ops_alert_merchant_idx").on(t.merchantId),
    unique("cod_ops_alert_source_key").on(t.sourceKey),
  ],
);
