/**
 * COD ledger service — the ONLY writer to `cod_entry` (PROJECT.md §4: "no
 * module reading another module's tables", and by the same rule no module
 * writing them).
 *
 * §8 in one sentence: cash-on-delivery is double-entry, append-only, and
 * reconciled at four checkpoints. This file implements checkpoints 1–3 and the
 * controls that guard them; settlement (4–5) lives in `settlement.ts`.
 *
 * There is intentionally NO update and NO delete function for `cod_entry` in
 * this file, mirroring `shared/audit.ts`. §8: "Entries are never edited or
 * deleted. Corrections are reversal entries that reference the original."
 * `reverseEntry()` is the only way to undo anything.
 */

import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../database";
import {
  codDeposit,
  codDepositItem,
  codEntry,
  codInvariantRun,
} from "../../database/schema/cod";
import { errors, isUniqueViolationOn, problem, fail } from "../../shared/errors";
import { formatLkr } from "../../shared/money";
import { enqueue } from "../../shared/outbox";
import { colomboToday } from "../../shared/time";
import { prefixedId } from "../../shared/ulid";
import { insertWithFreshCode, mintDocumentCode } from "../../shared/codes";
import { writeAudit } from "../../shared/audit";
import type { Principal } from "../../shared/auth";
import {
  ACCOUNTS,
  balances,
  fourWay,
  ledgerSum,
  liveEntries,
  negativeBreaches,
  posting,
  reverse,
  riderLiability,
  variancePosting,
  type CodEntryType,
  type Posting,
} from "./accounts";
import { CONFIG_KEYS, configValue } from "./config";
import { raiseHold } from "./holds";

export type CodEntryRow = typeof codEntry.$inferSelect;
export type CodDepositRow = typeof codDeposit.$inferSelect;

// ───────────────────────────────────────────────────────────────── internals

/**
 * Next human-facing sequence number. §8's ledger is read by auditors who ask
 * for "entry 4,812", so every row carries a monotonic integer alongside its
 * ULID.
 */
async function nextSeq(): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${codEntry.seq}), 0)` })
    .from(codEntry);
  return (row?.max ?? 0) + 1;
}

function mintDepositCode(date: string): string {
  return mintDocumentCode("DEP", date);
}

/**
 * Append one balanced entry.
 *
 * Private on purpose: every caller goes through a named checkpoint function so
 * that no code path can invent a posting the chart of accounts does not
 * sanction. `posting()` throws on a fractional, zero or negative amount, so an
 * unbalanced or float-valued row is unreachable from here.
 */
async function appendEntry(input: {
  type: CodEntryType;
  amountCents: number;
  mode?: "cash" | "bank" | "adjustment";
  ref?: string | null;
  parcelId?: string | null;
  awb?: string | null;
  merchantId?: string | null;
  riderId?: string | null;
  branchId?: string | null;
  depositId?: string | null;
  settlementId?: string | null;
  reversalOfId?: string | null;
  note?: string | null;
  clientId?: string | null;
  actor?: Principal | null;
  /**
   * A pre-built posting, for the entries whose legs are not implied by their
   * type alone: a signed VARIANCE (`variancePosting()`) and a REVERSAL
   * (`reverse()`). Still validated by the chart of accounts on the way in —
   * this is a choice between sanctioned leg pairs, not a bypass.
   */
  built?: Posting;
}): Promise<CodEntryRow> {
  const p = input.built ?? posting(input.type, input.amountCents);
  const id = prefixedId("cod");
  const values = {
    id,
    seq: await nextSeq(),
    type: p.type,
    amountCents: p.amountCents,
    debitAccount: p.debit,
    creditAccount: p.credit,
    mode: input.mode ?? "cash",
    ref: input.ref ?? null,
    parcelId: input.parcelId ?? null,
    awb: input.awb ?? null,
    merchantId: input.merchantId ?? null,
    riderId: input.riderId ?? null,
    branchId: input.branchId ?? null,
    depositId: input.depositId ?? null,
    settlementId: input.settlementId ?? null,
    reversalOfId: input.reversalOfId ?? null,
    reversedById: null,
    note: input.note ?? null,
    actorId: input.actor?.userId ?? null,
    actorName: input.actor?.name ?? null,
    actorRole: input.actor?.role ?? null,
    clientId: input.clientId ?? null,
    ts: new Date(),
  };

  try {
    await db.insert(codEntry).values(values);
  } catch (error) {
    // The two unique indexes on `cod_entry` are load-bearing domain rules, not
    // incidental constraints, so their violations are translated into the
    // problem documents §7 and §11 require rather than surfacing as 500s.
    //
    // Matched on the violated COLUMNS, not the index name: SQLite never names
    // the index, and Drizzle buries the driver message under `.cause`. Both
    // facts were verified against the live database before this was written.
    if (isUniqueViolationOn(error, "cod_entry.type", "cod_entry.parcel_id")) {
      // The index is on (type, parcel_id), so it guards "one entry of THIS
      // type per parcel" for every type — not just COLLECT. Reporting every
      // violation as "COD already collected" made an ACCRUE clash claim the
      // rider had collected twice, which is a problem document that lies.
      if (input.type === "COLLECT") {
        // §198, verbatim: "COD collected twice for one parcel → Second entry
        // rejected; both shown in reconciliation."
        fail(
          "CONFLICT",
          problem(
            "cod-already-collected",
            "COD already collected",
            409,
            `COD for ${input.awb ?? input.parcelId} is already recorded in the ledger. A second collection cannot be posted; raise a reversal if the first was wrong.`,
            { awb: input.awb, parcelId: input.parcelId },
          ),
        );
      }
      fail(
        "CONFLICT",
        problem(
          "cod-entry-already-posted",
          "Ledger entry already posted",
          409,
          `A ${input.type} entry already exists for ${input.awb ?? input.parcelId}. The ledger is append-only, so posting a second one would double-count it; reverse the first if it was wrong.`,
          { awb: input.awb, parcelId: input.parcelId, type: input.type },
        ),
      );
    }
    if (isUniqueViolationOn(error, "cod_entry.client_id") && input.clientId) {
      // §7/§109: a rider's phone retrying a delivery it already completed.
      // The money landed once; replay the original rather than erroring.
      const [existing] = await db
        .select()
        .from(codEntry)
        .where(eq(codEntry.clientId, input.clientId));
      if (existing) return existing;
    }
    throw error;
  }

  const [row] = await db.select().from(codEntry).where(eq(codEntry.id, id));
  return row!;
}

// ──────────────────────────────────────────────────── checkpoint 1 — COLLECT

/**
 * The ledger writer, for the rest of the `cod` module only.
 *
 * `settlement.ts` implements §8's checkpoints 4 and 5 and therefore has to post
 * SETTLE, FEE and TAX entries. It gets them through this one door rather than
 * inserting into `cod_entry` itself, so the invariants `appendEntry()` enforces
 * — chart-of-accounts legs, positive integer cents, a `seq`, the idempotency
 * constraints — hold for every row in the table without exception.
 *
 * Not for other modules: they call the named checkpoint functions.
 */
export async function appendLedgerEntry(
  input: Parameters<typeof appendEntry>[0],
): Promise<CodEntryRow> {
  return appendEntry(input);
}

export interface RecordCollectionInput {
  parcelId: string;
  awb: string;
  merchantId: string;
  riderId: string;
  branchId: string;
  amountCents: number;
  /** POD amount as captured on the doorstep, when it differs from the expected COD. */
  expectedCents?: number | null;
  mode?: "cash" | "bank";
  ref?: string | null;
  /** Client-minted id so an offline retry lands exactly once (§7). */
  clientId?: string | null;
  actor?: Principal | null;
}

/**
 * §8 checkpoint 1 — "Rider collects from consignee → cod_entry(type=COLLECT)".
 *
 * Called by the delivery module when a COD parcel is delivered. Returns the
 * entry plus whatever controls it tripped, so the caller can surface them on
 * the same response instead of the rider discovering a block later.
 */
export async function recordCollection(input: RecordCollectionInput): Promise<{
  entry: CodEntryRow;
  /** True when this was an offline retry that had already been counted. */
  replayed: boolean;
  /** POD amount ≠ expected COD → the parcel is held from settlement (§8 control). */
  mismatch: { expectedCents: number; collectedCents: number; varianceCents: number } | null;
  /** Rider is over the cash ceiling → further dispatch blocked (§8 control). */
  ceiling: { liabilityCents: number; ceilingCents: number; blocked: boolean };
}> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    fail(
      "BAD_REQUEST",
      problem(
        "invalid-amount",
        "Invalid COD amount",
        422,
        "A COD collection must be a positive whole number of cents.",
        { amountCents: input.amountCents },
      ),
    );
  }

  const before = await riderCashLiability(input.riderId);

  const entry = await appendEntry({
    type: "COLLECT",
    amountCents: input.amountCents,
    mode: input.mode ?? "cash",
    ref: input.ref ?? null,
    parcelId: input.parcelId,
    awb: input.awb,
    merchantId: input.merchantId,
    riderId: input.riderId,
    branchId: input.branchId,
    clientId: input.clientId ?? null,
    note: "COD collected from consignee",
    actor: input.actor,
  });

  const replayed = entry.amountCents !== input.amountCents || entry.ts.getTime() < before.asOf.getTime();

  // §8 control — "Amount mismatch: POD amount ≠ COD entry → parcel held from
  // settlement." The hold is what actually enforces it: the outbox event tells
  // ops, but only a `cod_hold` row is something `settlement.ts` can check
  // before it puts this parcel's money on a payout line.
  let mismatch: { expectedCents: number; collectedCents: number; varianceCents: number } | null = null;
  if (
    input.expectedCents != null &&
    input.expectedCents !== input.amountCents
  ) {
    mismatch = {
      expectedCents: input.expectedCents,
      collectedCents: input.amountCents,
      varianceCents: input.amountCents - input.expectedCents,
    };
    await raiseHold({
      scope: "parcel",
      reason: "amount_mismatch",
      merchantId: input.merchantId,
      parcelId: input.parcelId,
      awb: input.awb,
      entryId: entry.id,
      amountCents: mismatch.varianceCents,
      detail: `POD amount ${formatLkr(mismatch.collectedCents)} does not match the expected COD of ${formatLkr(mismatch.expectedCents)}.`,
      // One hold per parcel, whatever an offline retry does.
      sourceKey: `amount_mismatch:${input.parcelId}`,
      actor: input.actor,
    });
    await enqueue("cod.amount_mismatch", {
      parcelId: input.parcelId,
      awb: input.awb,
      riderId: input.riderId,
      expectedCents: mismatch.expectedCents,
      collectedCents: mismatch.collectedCents,
      varianceCents: mismatch.varianceCents,
    });
  }

  const ceiling = await checkCashCeiling(input.riderId);
  if (ceiling.blocked) {
    // "Rider exceeds configurable limit → further dispatch blocked" — ops are
    // notified rather than the rider simply failing their next scan.
    await enqueue("cod.ceiling_breached", {
      riderId: input.riderId,
      liabilityCents: ceiling.liabilityCents,
      ceilingCents: ceiling.ceilingCents,
    });
  }

  await writeAudit({
    entity: "cod_entry",
    entityId: entry.id,
    action: "cod.collected",
    actor: input.actor,
    after: {
      awb: input.awb,
      amountCents: input.amountCents,
      riderLiabilityCents: ceiling.liabilityCents,
      mismatch,
    },
  });

  return { entry, replayed, mismatch, ceiling };
}

// ───────────────────────────────────────── checkpoints 2 and 3 — cash custody

/**
 * §8 checkpoint 2 — "Rider deposits at branch/hub → cod_entry(type=DEPOSIT)".
 *
 * The rider declares an amount and names the collections it covers. No ledger
 * entry is written yet: the cash has not been counted, and posting it before
 * the count would make the branch's books claim money nobody has verified.
 * The DEPOSIT entries are written by `verifyDeposit()`.
 */
export async function declareDeposit(input: {
  riderId: string;
  riderName: string;
  branchId: string;
  declaredCents: number;
  /** Ledger ids of the COLLECT entries being handed over. */
  entryIds: string[];
  note?: string | null;
  actor?: Principal | null;
}): Promise<CodDepositRow> {
  if (!input.entryIds.length) {
    fail(
      "BAD_REQUEST",
      problem("empty-deposit", "Nothing to deposit", 422, "A deposit must name at least one collection."),
    );
  }

  const entries = await db
    .select()
    .from(codEntry)
    .where(inArray(codEntry.id, input.entryIds));

  if (entries.length !== input.entryIds.length) {
    errors.notFound("One or more COD entries");
  }
  for (const entry of entries) {
    if (entry.type !== "COLLECT") {
      fail(
        "BAD_REQUEST",
        problem(
          "not-a-collection",
          "Not a collection",
          422,
          `Entry ${entry.seq} is a ${entry.type}, not a COLLECT, and cannot be deposited.`,
          { entryId: entry.id, entryType: entry.type },
        ),
      );
    }
    if (entry.riderId !== input.riderId) {
      errors.forbidden("That collection belongs to another rider.", { entryId: entry.id });
    }
  }

  const expected = entries.reduce((sum, e) => sum + e.amountCents, 0);
  const date = colomboToday();
  const id = prefixedId("dep");

  await insertWithFreshCode("cod_deposit", () => mintDepositCode(date), (code) => db.insert(codDeposit).values({
    id,
    code,
    riderId: input.riderId,
    riderName: input.riderName,
    branchId: input.branchId,
    depositDate: date,
    expectedCents: expected,
    declaredCents: input.declaredCents,
    countedCents: null,
    varianceCents: null,
    declaredVarianceCents: null,
    status: "declared",
    varianceReason: null,
    note: input.note ?? null,
    createdAt: new Date(),
    createdByName: input.actor?.name ?? input.riderName,
  }));

  try {
    await db.insert(codDepositItem).values(
      entries.map((entry) => ({
        id: prefixedId("dpi"),
        depositId: id,
        entryId: entry.id,
        parcelId: entry.parcelId ?? "",
        awb: entry.awb ?? "",
        amountCents: entry.amountCents,
      })),
    );
  } catch (error) {
    if (isUniqueViolationOn(error, "cod_deposit_item.entry_id")) {
      // The unique index on entry_id: a collection can only be deposited once.
      await db.delete(codDeposit).where(eq(codDeposit.id, id));
      fail(
        "CONFLICT",
        problem(
          "already-deposited",
          "Collection already deposited",
          409,
          "One of those collections is already part of another deposit.",
        ),
      );
    }
    throw error;
  }

  await writeAudit({
    entity: "cod_deposit",
    entityId: id,
    action: "cod.deposit_declared",
    actor: input.actor,
    after: { declaredCents: input.declaredCents, expectedCents: expected, entries: entries.length },
  });

  const [row] = await db.select().from(codDeposit).where(eq(codDeposit.id, id));
  return row!;
}

/**
 * The cashier counts the cash.
 *
 * A difference between counted and declared is stored as an explicit VARIANCE
 * entry, never silently reconciled — §8 requires variance "highlighted at each
 * stage", and a shortfall is the single most important signal in a COD
 * operation. The DEPOSIT entries are posted for what was actually counted.
 */
export async function verifyDeposit(input: {
  depositId: string;
  countedCents: number;
  varianceReason?: string | null;
  actor?: Principal | null;
}): Promise<{
  deposit: CodDepositRow;
  entries: CodEntryRow[];
  /** counted − expected: the gap the ledger had to absorb. */
  varianceCents: number;
  /** counted − declared: the rider's own miscount, which posts nothing. */
  declaredVarianceCents: number;
}> {
  const [deposit] = await db.select().from(codDeposit).where(eq(codDeposit.id, input.depositId));
  if (!deposit) errors.notFound("Deposit");
  if (deposit!.status !== "declared") {
    errors.conflict(`Deposit ${deposit!.code} is already ${deposit!.status}.`, {
      currentStatus: deposit!.status,
    });
  }

  const items = await db
    .select()
    .from(codDepositItem)
    .where(eq(codDepositItem.depositId, input.depositId));

  // Two different variances, and conflating them was a real bug: the ledger
  // one is measured against the COLLECT entries being handed over, not against
  // the rider's claim. The DEPOSIT postings relieve the rider of exactly those
  // collections (§218's "Σ collected − Σ deposited = rider cash liability"),
  // so the only gap a double-entry book has to absorb is between them and the
  // cash that actually reached the safe. Measuring it against `declaredCents`
  // instead left BRANCH_CASH short by the rider's miscount even when every
  // rupee was accounted for.
  const expected = items.reduce((sum, item) => sum + item.amountCents, 0);
  const variance = input.countedCents - expected;
  const declaredVariance = input.countedCents - deposit!.declaredCents;

  if ((variance !== 0 || declaredVariance !== 0) && !input.varianceReason) {
    const gap = variance !== 0 ? variance : declaredVariance;
    const against = variance !== 0 ? "the collections on this deposit" : "the declared amount";
    fail(
      "BAD_REQUEST",
      problem(
        "variance-reason-required",
        "Variance reason required",
        422,
        `The count is ${formatLkr(Math.abs(gap))} ${gap < 0 ? "short of" : "over"} ${against}. A reason is required before the deposit can be verified.`,
        { varianceCents: variance, declaredVarianceCents: declaredVariance },
      ),
    );
  }

  // Post one DEPOSIT per collection so the ledger keeps the parcel dimension:
  // a lump-sum entry would make "which parcels has this rider settled?"
  // unanswerable, which is what §8's traceability rule forbids.
  const written: CodEntryRow[] = [];
  for (const item of items) {
    written.push(
      await appendEntry({
        type: "DEPOSIT",
        amountCents: item.amountCents,
        parcelId: item.parcelId,
        awb: item.awb,
        riderId: deposit!.riderId,
        branchId: deposit!.branchId,
        depositId: deposit!.id,
        note: `Deposited at counter on ${deposit!.code}`,
        actor: input.actor,
      }),
    );
    await db
      .update(codEntry)
      .set({ depositId: deposit!.id })
      .where(eq(codEntry.id, item.entryId));
  }

  // Only the ledger variance produces an entry. A pure miscount by the rider
  // (counted ≠ declared but counted == expected) moves no money, so it is
  // recorded on the deposit and escalated, but posting it would unbalance a
  // book in which nothing is actually missing.
  const variancePost = variancePosting(variance);
  if (variancePost) {
    written.push(
      await appendEntry({
        type: "VARIANCE",
        amountCents: variancePost.amountCents,
        built: variancePost,
        riderId: deposit!.riderId,
        branchId: deposit!.branchId,
        depositId: deposit!.id,
        mode: "adjustment",
        note: `Count variance on ${deposit!.code}: ${input.varianceReason}`,
        actor: input.actor,
      }),
    );
  }

  if (variance !== 0 || declaredVariance !== 0) {
    // §8 control — "Settlement hold: any open variance blocks that merchant's
    // payout." A count variance belongs to the bag, not to one parcel, so
    // every parcel in the bag is held: the money that is short came from some
    // subset of them and nothing here can say which. Conservative on purpose —
    // paying a merchant for cash that never reached the safe is the failure
    // §8 exists to prevent, and a hold is cleared by a human in minutes.
    const merchantByEntry = new Map(
      (
        await db
          .select({ id: codEntry.id, merchantId: codEntry.merchantId })
          .from(codEntry)
          .where(inArray(codEntry.id, items.map((item) => item.entryId)))
      ).map((row) => [row.id, row.merchantId]),
    );
    for (const item of items) {
      const merchantId = merchantByEntry.get(item.entryId);
      if (!merchantId) continue;
      await raiseHold({
        scope: "parcel",
        reason: "deposit_variance",
        merchantId,
        parcelId: item.parcelId,
        awb: item.awb,
        entryId: item.entryId,
        depositId: deposit!.id,
        amountCents: variance !== 0 ? variance : declaredVariance,
        detail: `Deposit ${deposit!.code} counted ${formatLkr(input.countedCents)} against ${formatLkr(expected)} of collections (declared ${formatLkr(deposit!.declaredCents)}). Reason given: ${input.varianceReason}`,
        sourceKey: `deposit_variance:${deposit!.id}:${item.parcelId}`,
        actor: input.actor,
      });
    }

    await enqueue("cod.deposit_variance", {
      depositId: deposit!.id,
      code: deposit!.code,
      riderId: deposit!.riderId,
      expectedCents: expected,
      declaredCents: deposit!.declaredCents,
      countedCents: input.countedCents,
      varianceCents: variance,
      declaredVarianceCents: declaredVariance,
      reason: input.varianceReason ?? null,
    });
  }

  await db
    .update(codDeposit)
    .set({
      countedCents: input.countedCents,
      varianceCents: variance,
      declaredVarianceCents: declaredVariance,
      varianceReason: input.varianceReason ?? null,
      status: "verified",
      verifiedById: input.actor?.userId ?? null,
      verifiedByName: input.actor?.name ?? null,
      verifiedAt: new Date(),
    })
    .where(eq(codDeposit.id, input.depositId));

  await writeAudit({
    entity: "cod_deposit",
    entityId: input.depositId,
    action: "cod.deposit_verified",
    actor: input.actor,
    before: { status: "declared", declaredCents: deposit!.declaredCents, expectedCents: expected },
    after: {
      status: "verified",
      countedCents: input.countedCents,
      varianceCents: variance,
      declaredVarianceCents: declaredVariance,
    },
  });

  const [row] = await db.select().from(codDeposit).where(eq(codDeposit.id, input.depositId));
  return {
    deposit: row!,
    entries: written,
    varianceCents: variance,
    declaredVarianceCents: declaredVariance,
  };
}

/**
 * §8 checkpoint 3 — "Branch verifies and banks the cash →
 * cod_entry(type=BANK)". One entry for the banked total, carrying the bank's
 * own reference so the four-way reconciliation can be tied to a statement.
 */
export async function bankDeposit(input: {
  depositId: string;
  bankRef: string;
  bankAccount: string;
  actor?: Principal | null;
}): Promise<{
  deposit: CodDepositRow;
  entry: CodEntryRow;
  /** One ACCRUE per collection — what each merchant is now owed. */
  accruals: CodEntryRow[];
}> {
  const [deposit] = await db.select().from(codDeposit).where(eq(codDeposit.id, input.depositId));
  if (!deposit) errors.notFound("Deposit");
  if (deposit!.status !== "verified") {
    errors.conflict(
      `Deposit ${deposit!.code} is ${deposit!.status}; only a verified deposit can be banked.`,
      { currentStatus: deposit!.status },
    );
  }

  const amount = deposit!.countedCents ?? 0;
  const entry = await appendEntry({
    type: "BANK",
    amountCents: amount,
    mode: "bank",
    ref: input.bankRef,
    riderId: deposit!.riderId,
    branchId: deposit!.branchId,
    depositId: deposit!.id,
    note: `Banked to ${input.bankAccount}`,
    actor: input.actor,
  });

  // Recognise the merchants' claims on the cash now that it is NatEx's to
  // hold. One ACCRUE per collection, so a settlement line can point at a
  // parcel — an aggregate per merchant would make "which parcels does this
  // payout cover?" unanswerable, which is the traceability §8 demands.
  //
  // The accrual is the sum of the *collections*, not the counted cash: what a
  // merchant is owed does not change because a rider's bag came up short. That
  // gap is already sitting in CASH_VARIANCE from the count, where it is
  // someone's job to explain it.
  const items = await db
    .select()
    .from(codDepositItem)
    .where(eq(codDepositItem.depositId, input.depositId));
  const collects = items.length
    ? await db
        .select({ id: codEntry.id, merchantId: codEntry.merchantId })
        .from(codEntry)
        .where(inArray(codEntry.id, items.map((item) => item.entryId)))
    : [];
  const merchantByEntry = new Map(collects.map((row) => [row.id, row.merchantId]));

  const accruals: CodEntryRow[] = [];
  for (const item of items) {
    const merchantId = merchantByEntry.get(item.entryId) ?? null;
    accruals.push(
      await appendEntry({
        type: "ACCRUE",
        amountCents: item.amountCents,
        mode: "adjustment",
        ref: input.bankRef,
        parcelId: item.parcelId,
        awb: item.awb,
        merchantId,
        // The accrual is merchant-side money, but it arose from this rider's
        // banked cash: carrying the rider keeps "which collection became this
        // payable" answerable without walking the deposit.
        riderId: deposit!.riderId,
        branchId: deposit!.branchId,
        depositId: deposit!.id,
        note: `COD payable to merchant, banked on ${deposit!.code}`,
        actor: input.actor,
      }),
    );
  }

  await db
    .update(codDeposit)
    .set({
      status: "banked",
      bankRef: input.bankRef,
      bankAccount: input.bankAccount,
      bankedAt: new Date(),
    })
    .where(eq(codDeposit.id, input.depositId));

  await writeAudit({
    entity: "cod_deposit",
    entityId: input.depositId,
    action: "cod.deposit_banked",
    actor: input.actor,
    before: { status: "verified" },
    after: {
      status: "banked",
      bankRef: input.bankRef,
      amountCents: amount,
      accruedCents: accruals.reduce((sum, row) => sum + row.amountCents, 0),
    },
  });

  const [row] = await db.select().from(codDeposit).where(eq(codDeposit.id, input.depositId));
  return { deposit: row!, entry, accruals };
}

// ──────────────────────────────────────────────────────────────── correction

/**
 * The only way to undo an entry (§8: "Corrections are reversal entries that
 * reference the original").
 *
 * Both rows stay in the table forever. The original is stamped with
 * `reversedById` so reconciliation can show the pair, per §198's "both shown
 * in reconciliation", while `liveEntries()` excludes them from balances.
 */
export async function reverseEntry(input: {
  entryId: string;
  reason: string;
  actor?: Principal | null;
}): Promise<{ original: CodEntryRow; reversal: CodEntryRow }> {
  const [original] = await db.select().from(codEntry).where(eq(codEntry.id, input.entryId));
  if (!original) errors.notFound("Ledger entry");
  if (original!.reversedById) {
    errors.conflict(`Entry ${original!.seq} has already been reversed.`, {
      reversedById: original!.reversedById,
    });
  }
  if (original!.reversalOfId) {
    errors.conflict("A reversal cannot itself be reversed; post a fresh entry instead.");
  }
  if (!input.reason?.trim()) {
    fail(
      "BAD_REQUEST",
      problem("reason-required", "Reason required", 422, "A reversal must record why it was made."),
    );
  }

  const mirrored = reverse({
    type: original!.type as CodEntryType,
    amountCents: original!.amountCents,
    debit: original!.debitAccount as never,
    credit: original!.creditAccount as never,
  });

  // Written directly rather than through appendEntry(), because a reversal's
  // legs come from the row it mirrors, not from the chart of accounts.
  const id = prefixedId("cod");
  await db.insert(codEntry).values({
    id,
    seq: await nextSeq(),
    type: "REVERSAL",
    amountCents: mirrored.amountCents,
    debitAccount: mirrored.debit,
    creditAccount: mirrored.credit,
    mode: "adjustment",
    ref: original!.ref,
    parcelId: original!.parcelId,
    awb: original!.awb,
    merchantId: original!.merchantId,
    riderId: original!.riderId,
    branchId: original!.branchId,
    depositId: original!.depositId,
    settlementId: original!.settlementId,
    reversalOfId: original!.id,
    reversedById: null,
    note: `Reversal of entry ${original!.seq}: ${input.reason}`,
    actorId: input.actor?.userId ?? null,
    actorName: input.actor?.name ?? null,
    actorRole: input.actor?.role ?? null,
    clientId: null,
    ts: new Date(),
  });

  // The original's only mutable field, and only ever set once. It is a pointer
  // to the correction, not a change to what the entry recorded.
  await db.update(codEntry).set({ reversedById: id }).where(eq(codEntry.id, original!.id));

  await writeAudit({
    entity: "cod_entry",
    entityId: original!.id,
    action: "cod.reversed",
    actor: input.actor,
    before: { seq: original!.seq, amountCents: original!.amountCents },
    after: { reversalId: id, reason: input.reason },
  });

  const [reversal] = await db.select().from(codEntry).where(eq(codEntry.id, id));
  const [updated] = await db.select().from(codEntry).where(eq(codEntry.id, original!.id));
  return { original: updated!, reversal: reversal! };
}

// ──────────────────────────────────────────────────────────────── read paths

/** Live entries for one rider — reversed pairs excluded. */
async function riderEntries(riderId: string): Promise<CodEntryRow[]> {
  const rows = await db
    .select()
    .from(codEntry)
    .where(eq(codEntry.riderId, riderId))
    .orderBy(asc(codEntry.seq));
  return liveEntries(rows);
}

/**
 * §8's balance invariant for one rider: Σ collected − Σ deposited.
 *
 * This is the number the cash ceiling is checked against and the number the
 * nightly job asserts, so both read the same definition.
 */
export async function riderCashLiability(riderId: string): Promise<{
  riderId: string;
  liabilityCents: number;
  accountBalanceCents: number;
  asOf: Date;
}> {
  const rows = await riderEntries(riderId);
  const table = balances(rows);
  return {
    riderId,
    liabilityCents: riderLiability(rows),
    accountBalanceCents: table[ACCOUNTS.RIDER_CASH] ?? 0,
    asOf: new Date(),
  };
}

/**
 * §8 control — "Cash-in-hand ceiling: Rider exceeds configurable limit →
 * further dispatch blocked."
 *
 * The limit is a config row (Rs. 50,000 per the client's answer to §15 q9),
 * not a constant, so finance can raise it for a festival week without a
 * deploy.
 */
export async function checkCashCeiling(riderId: string): Promise<{
  riderId: string;
  liabilityCents: number;
  ceilingCents: number;
  blocked: boolean;
  headroomCents: number;
}> {
  const ceilingCents = await configValue(CONFIG_KEYS.RIDER_CASH_CEILING_CENTS);
  const { liabilityCents } = await riderCashLiability(riderId);
  return {
    riderId,
    liabilityCents,
    ceilingCents,
    blocked: liabilityCents > ceilingCents,
    headroomCents: ceilingCents - liabilityCents,
  };
}

/**
 * Every rider the ledger has ever seen, with the cash they are holding now —
 * the finance desk's "who has our money" board (§8 checkpoint 1→2).
 *
 * Computed from this module's own entries only (§4): the rider's name is the
 * actor name on their latest collection, so no identity table is read.
 */
export async function riderCashBoard(): Promise<
  {
    riderId: string;
    riderName: string | null;
    branchId: string | null;
    liabilityCents: number;
    accountBalanceCents: number;
    collectedCents: number;
    depositedCents: number;
    lastCollectAt: Date | null;
    ceilingCents: number;
    overCeiling: boolean;
  }[]
> {
  const ceilingCents = await configValue(CONFIG_KEYS.RIDER_CASH_CEILING_CENTS);
  const live = liveEntries(await db.select().from(codEntry).orderBy(asc(codEntry.seq)));
  const byRider = new Map<string, CodEntryRow[]>();
  for (const row of live) {
    if (!row.riderId) continue;
    const list = byRider.get(row.riderId) ?? [];
    list.push(row);
    byRider.set(row.riderId, list);
  }
  const out = [...byRider.entries()].map(([riderId, rows]) => {
    const collects = rows.filter((r) => r.type === "COLLECT");
    const last = collects[collects.length - 1] ?? null;
    const liabilityCents = riderLiability(rows);
    return {
      riderId,
      riderName: last?.actorName ?? null,
      branchId: last?.branchId ?? rows[rows.length - 1]?.branchId ?? null,
      liabilityCents,
      accountBalanceCents: balances(rows)[ACCOUNTS.RIDER_CASH] ?? 0,
      collectedCents: collects.reduce((sum, r) => sum + r.amountCents, 0),
      depositedCents: rows.filter((r) => r.type === "DEPOSIT").reduce((sum, r) => sum + r.amountCents, 0),
      lastCollectAt: last?.ts ?? null,
      ceilingCents,
      overCeiling: liabilityCents > ceilingCents,
    };
  });
  return out.sort((a, b) => b.liabilityCents - a.liabilityCents);
}

/**
 * The dispatch gate. Called by the delivery module before a runsheet is
 * dispatched; throws the problem document that tells ops why, rather than
 * returning a bare boolean the caller might ignore.
 */
export async function assertDispatchAllowed(riderId: string, riderName?: string): Promise<void> {
  const check = await checkCashCeiling(riderId);
  if (check.blocked) {
    fail(
      "FORBIDDEN",
      problem(
        "cash-ceiling-exceeded",
        "Rider cash ceiling exceeded",
        403,
        `${riderName ?? "This rider"} is holding ${formatLkr(check.liabilityCents)}, over the ${formatLkr(check.ceilingCents)} ceiling. Cash must be deposited before further dispatch.`,
        {
          riderId,
          liabilityCents: check.liabilityCents,
          ceilingCents: check.ceilingCents,
        },
      ),
    );
  }
}

/**
 * §8 control — "Stale collection: Collected > 48 h without deposit → escalate
 * to ops."
 *
 * Read-only; the nightly job calls this and enqueues the escalation, so the
 * finance portal can show the same list without side effects.
 */
export async function staleCollections(now: Date = new Date()): Promise<
  {
    entryId: string;
    seq: number;
    awb: string | null;
    riderId: string | null;
    amountCents: number;
    collectedAt: Date;
    ageHours: number;
  }[]
> {
  const hours = await configValue(CONFIG_KEYS.STALE_COLLECTION_HOURS);
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  const rows = await db
    .select()
    .from(codEntry)
    .where(
      and(
        eq(codEntry.type, "COLLECT"),
        isNull(codEntry.depositId),
        isNull(codEntry.reversedById),
        lt(codEntry.ts, cutoff),
      ),
    )
    .orderBy(asc(codEntry.ts));

  return rows.map((row) => ({
    entryId: row.id,
    seq: row.seq,
    awb: row.awb,
    riderId: row.riderId,
    amountCents: row.amountCents,
    collectedAt: row.ts,
    ageHours: Math.floor((now.getTime() - row.ts.getTime()) / 3_600_000),
  }));
}

/**
 * §8 — "Four-way reconciliation: collected vs deposited vs banked vs settled,
 * with variance highlighted at each stage."
 */
export async function reconciliation(filter?: {
  riderId?: string;
  merchantId?: string;
  branchId?: string;
}) {
  const conditions = [];
  if (filter?.riderId) conditions.push(eq(codEntry.riderId, filter.riderId));
  if (filter?.merchantId) conditions.push(eq(codEntry.merchantId, filter.merchantId));
  if (filter?.branchId) conditions.push(eq(codEntry.branchId, filter.branchId));

  const rows = conditions.length
    ? await db.select().from(codEntry).where(and(...conditions))
    : await db.select().from(codEntry);

  const live = liveEntries(rows);
  const stages = fourWay(live);
  const table = balances(live);

  return {
    ...stages,
    /**
     * Counted-vs-expected differences still sitting in the variance account.
     * Positive = cash is missing, negative = more arrived than the parcels
     * said. Taken straight from the account balance: a shortfall debits
     * CASH_VARIANCE, so the balance is already positive-when-short and
     * negating it reported every shortfall as a surplus.
     */
    openVarianceCents: table[ACCOUNTS.CASH_VARIANCE] ?? 0,
    entryCount: rows.length,
    liveEntryCount: live.length,
    reversedEntryCount: rows.length - live.length,
    /** Must be zero. Anything else means the ledger was written outside this module. */
    ledgerSumCents: ledgerSum(live),
  };
}

/** Paged ledger browser for the finance portal (§10 M4 "ledger browser"). */
export async function listEntries(input: {
  type?: CodEntryType[];
  riderId?: string;
  merchantId?: string;
  parcelId?: string;
  awb?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: CodEntryRow[]; total: number }> {
  const conditions = [];
  if (input.type?.length) conditions.push(inArray(codEntry.type, input.type));
  if (input.riderId) conditions.push(eq(codEntry.riderId, input.riderId));
  if (input.merchantId) conditions.push(eq(codEntry.merchantId, input.merchantId));
  if (input.parcelId) conditions.push(eq(codEntry.parcelId, input.parcelId));
  if (input.awb) conditions.push(eq(codEntry.awb, input.awb));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(codEntry)
    .where(where)
    .orderBy(desc(codEntry.seq))
    .limit(Math.min(input.limit ?? 50, 200))
    .offset(input.offset ?? 0);

  const [count] = await db
    .select({ n: sql<number>`count(*)` })
    .from(codEntry)
    .where(where);

  return { rows, total: count?.n ?? 0 };
}

/** Deposits awaiting a cashier's count, for the reconciliation screen. */
export interface DepositFilter {
  branchId?: string;
  riderId?: string;
  status?: ("declared" | "verified" | "banked" | "rejected")[];
  limit?: number;
  offset?: number;
}

function depositWhere(input: DepositFilter) {
  const conditions = [];
  if (input.branchId) conditions.push(eq(codDeposit.branchId, input.branchId));
  if (input.riderId) conditions.push(eq(codDeposit.riderId, input.riderId));
  if (input.status?.length) conditions.push(inArray(codDeposit.status, input.status));
  return conditions.length ? and(...conditions) : undefined;
}

export async function listDeposits(input: DepositFilter): Promise<CodDepositRow[]> {
  return db
    .select()
    .from(codDeposit)
    .where(depositWhere(input))
    .orderBy(desc(codDeposit.createdAt))
    .limit(Math.min(input.limit ?? 50, 200))
    .offset(input.offset ?? 0);
}

/** One page plus the filtered total (§11 server-side paging). */
export async function depositPage(
  input: DepositFilter,
): Promise<{ rows: CodDepositRow[]; total: number }> {
  const [rows, [count]] = await Promise.all([
    listDeposits(input),
    db.select({ n: sql<number>`count(*)` }).from(codDeposit).where(depositWhere(input)),
  ]);
  return { rows, total: Number(count?.n ?? 0) };
}

/**
 * The live COLLECT entry for one parcel, if any. The delivery module asks this
 * before it signs a parcel over, so a second collection is refused BEFORE a
 * parcel changes hands rather than discovered by the unique index after.
 */
export async function collectionForParcel(parcelId: string): Promise<CodEntryRow | null> {
  const [row] = await db
    .select()
    .from(codEntry)
    .where(and(eq(codEntry.parcelId, parcelId), eq(codEntry.type, "COLLECT")))
    .limit(1);
  return row ?? null;
}

/** The collections a rider is still holding cash for — the deposit screen. */
export async function undepositedCollections(riderId: string): Promise<CodEntryRow[]> {
  const rows = await db
    .select()
    .from(codEntry)
    .where(
      and(
        eq(codEntry.riderId, riderId),
        eq(codEntry.type, "COLLECT"),
        isNull(codEntry.depositId),
        isNull(codEntry.reversedById),
      ),
    )
    .orderBy(asc(codEntry.ts));
  return rows;
}

// ───────────────────────────────────────────────── nightly invariant job (§8)

/**
 * §8: "Balance invariant: Σ collected − Σ deposited = rider cash liability.
 * Checked nightly by a job. A negative balance is impossible by design and
 * must trigger immediate investigation." / §10 M4: "Nightly balance-invariant
 * job".
 *
 * Every run is stored in `cod_invariant_run`, so "the invariant held every
 * night last quarter" is a query rather than a claim.
 */
export async function runBalanceInvariant(
  now: Date = new Date(),
  trigger: "scheduled" | "manual" = "manual",
): Promise<{
  runId: string;
  result: "ok" | "breached";
  ridersChecked: number;
  breaches: {
    kind: "negative_account" | "invariant_mismatch" | "ledger_unbalanced";
    riderId?: string;
    detail: string;
    amountCents: number;
  }[];
  riderLiabilityCents: number;
  ledgerSumCents: number;
  staleCount: number;
}> {
  const allRows = await db.select().from(codEntry);
  const live = liveEntries(allRows);

  const breaches: {
    kind: "negative_account" | "invariant_mismatch" | "ledger_unbalanced";
    riderId?: string;
    detail: string;
    amountCents: number;
  }[] = [];

  // 1. The whole book must sum to zero. A non-zero total means a row was
  // written outside this module, which is corruption rather than a variance.
  const sum = ledgerSum(live);
  if (sum !== 0) {
    breaches.push({
      kind: "ledger_unbalanced",
      detail: `Ledger-wide account sum is ${sum} cents; double-entry requires exactly 0.`,
      amountCents: sum,
    });
  }

  // 2. Per rider: the §8 invariant must equal the RIDER_CASH account, and
  // neither may be negative.
  const riderIds = [
    ...new Set(live.map((r) => r.riderId).filter((id): id is string => Boolean(id))),
  ];
  let totalLiability = 0;
  for (const riderId of riderIds) {
    const rows = live.filter((r) => r.riderId === riderId);
    const invariant = riderLiability(rows);
    const account = balances(rows)[ACCOUNTS.RIDER_CASH] ?? 0;
    totalLiability += invariant;

    if (invariant !== account) {
      breaches.push({
        kind: "invariant_mismatch",
        riderId,
        detail: `Σ collected − Σ deposited is ${invariant} but the rider_cash account holds ${account}.`,
        amountCents: invariant - account,
      });
    }
    for (const breach of negativeBreaches(rows)) {
      breaches.push({
        kind: "negative_account",
        riderId,
        detail: `${breach.account} is negative (${breach.balanceCents} cents) — impossible by design, investigate immediately.`,
        amountCents: breach.balanceCents,
      });
    }
  }

  // 3. Stale collections are escalated on the same pass (§8's second control).
  const stale = await staleCollections(now);
  for (const item of stale) {
    await enqueue("cod.stale_collection", {
      entryId: item.entryId,
      awb: item.awb,
      riderId: item.riderId,
      amountCents: item.amountCents,
      ageHours: item.ageHours,
    });
  }

  const runId = prefixedId("inv");
  const result = breaches.length ? ("breached" as const) : ("ok" as const);

  await db.insert(codInvariantRun).values({
    id: runId,
    runDate: colomboToday(now),
    result,
    ridersChecked: riderIds.length,
    breachCount: breaches.length,
    riderLiabilityCents: totalLiability,
    ledgerSumCents: sum,
    detailsJson: JSON.stringify({ breaches, stale }),
    trigger,
    ranAt: now,
  });

  if (breaches.length) {
    await enqueue("cod.invariant_breached", {
      runId,
      breachCount: breaches.length,
      breaches: breaches.slice(0, 20),
    });
  }

  return {
    runId,
    result,
    ridersChecked: riderIds.length,
    breaches,
    riderLiabilityCents: totalLiability,
    ledgerSumCents: sum,
    staleCount: stale.length,
  };
}

/** Whether the nightly job has already run for a Colombo calendar day. */
export async function hasScheduledInvariantRun(runDate: string): Promise<boolean> {
  const [row] = await db
    .select({ id: codInvariantRun.id })
    .from(codInvariantRun)
    .where(and(eq(codInvariantRun.runDate, runDate), eq(codInvariantRun.trigger, "scheduled")))
    .limit(1);
  return Boolean(row);
}

/** The last N invariant runs, for the finance dashboard. */
export async function listInvariantRuns(limit = 30) {
  return db
    .select()
    .from(codInvariantRun)
    .orderBy(desc(codInvariantRun.ranAt))
    .limit(Math.min(limit, 100));
}
