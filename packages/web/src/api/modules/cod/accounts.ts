/**
 * Chart of accounts and double-entry arithmetic for the COD ledger.
 *
 * PROJECT.md §8, non-negotiable (§1, §413): "No cash-on-delivery amount may be
 * untraceable. Every COD rupee is recorded in an append-only, double-entry
 * ledger and reconciled at four checkpoints."
 *
 * This file is pure arithmetic — no database, no I/O — so the ledger rules can
 * be unit-tested on their own (§345: "Unit tests cover the domain rules
 * (state machine, ledger arithmetic, pricing)"). `service.ts` is the only
 * place that turns these postings into rows.
 *
 * Money is an integer number of cents everywhere (§9). Nothing here divides
 * without rounding to an integer, and no function returns a float.
 */

// ────────────────────────────────────────────────────────────── entry types

/**
 * The kinds of movement the ledger records, mirroring §8's five checkpoints
 * plus the two entries that keep it honest.
 *
 * Declared here rather than in the schema file, following `ParcelStatus` in
 * `modules/parcels/state-machine.ts`: the domain owns its vocabulary and the
 * table stores it as text.
 */
export const COD_ENTRY_TYPES = [
  /** §8 checkpoint 1 — rider collects from consignee. */
  "COLLECT",
  /** §8 checkpoint 2 — rider deposits at branch/hub. */
  "DEPOSIT",
  /** §8 checkpoint 3 — branch verifies and banks the cash. */
  "BANK",
  /**
   * Recognition of what NatEx owes a merchant, posted the moment their COD is
   * banked. Without it nothing ever credits MERCHANT_PAYABLE and a SETTLE has
   * no liability to discharge — see the account's own comment below.
   */
  "ACCRUE",
  /** §8 checkpoint 5 — payout executed against the merchant payable. */
  "SETTLE",
  /** A deduction NatEx keeps: COD fee, RTO fee, forwarding, weight discrepancy. */
  "FEE",
  /** VAT/SSCL withheld on a settlement. Inactive until §15 q10 is answered. */
  "TAX",
  /** A counted-vs-declared difference, named rather than hidden. */
  "VARIANCE",
  /** A correction referencing the row it reverses. */
  "REVERSAL",
] as const;

export type CodEntryType = (typeof COD_ENTRY_TYPES)[number];

export function isCodEntryType(value: string): value is CodEntryType {
  return (COD_ENTRY_TYPES as readonly string[]).includes(value);
}

// ───────────────────────────────────────────────────────── chart of accounts

/**
 * Every account the COD ledger can post to.
 *
 * Deliberately small. A courier COD ledger only tracks cash as it moves from a
 * consignee's hand to a merchant's bank account, so the accounts are the places
 * that cash can physically or legally sit, plus the income and variance
 * accounts that absorb the difference.
 */
export const ACCOUNTS = {
  /**
   * The consignee's money before it is collected. Credited on COLLECT: the
   * origin of every rupee in the ledger, so the books balance from the first
   * entry rather than starting with an unexplained credit.
   */
  CONSIGNEE_DUE: "consignee_due",
  /**
   * Cash physically in a rider's pocket. The balance invariant of §8 —
   * "Σ collected − Σ deposited = rider cash liability" — is exactly this
   * account's balance, per rider.
   */
  RIDER_CASH: "rider_cash",
  /** Cash counted and held in a branch/hub safe, not yet banked. */
  BRANCH_CASH: "branch_cash",
  /** Cash deposited into NatEx's own bank account. */
  BANK: "bank",
  /**
   * What NatEx owes the merchant. A credit balance here is a payable; it is
   * cleared by SETTLE once the payout leaves the bank.
   */
  MERCHANT_PAYABLE: "merchant_payable",
  /** NatEx's fee income: COD fee, RTO fee, forwarding, weight discrepancy. */
  FEE_INCOME: "fee_income",
  /**
   * Counted-minus-declared differences. §8 requires variance to be
   * "highlighted at each stage" rather than silently absorbed, so a shortfall
   * or overage lands in its own account and shows up in reconciliation.
   */
  CASH_VARIANCE: "cash_variance",
  /** Tax collected on behalf of the state. Inactive until registration is confirmed (§15 q10). */
  TAX_PAYABLE: "tax_payable",
} as const;

export type Account = (typeof ACCOUNTS)[keyof typeof ACCOUNTS];

/** Every account, for iteration in the nightly invariant job. */
export const ALL_ACCOUNTS: Account[] = Object.values(ACCOUNTS);

/**
 * Accounts whose balance may never go negative, and why.
 *
 * §8: "A negative balance is impossible by design and must trigger immediate
 * investigation." A rider cannot hand over cash they never collected, and a
 * branch cannot bank more than it counted.
 */
export const NON_NEGATIVE_ACCOUNTS: Account[] = [
  ACCOUNTS.RIDER_CASH,
  ACCOUNTS.BRANCH_CASH,
];

// ──────────────────────────────────────────────────────────────── a posting

/**
 * One balanced movement: the same amount leaves `debit` and arrives at
 * `credit`. Both legs live on a single `cod_entry` row, which is what makes
 * the ledger provably balanced — an unbalanced entry is unrepresentable
 * rather than merely discouraged.
 */
export type Posting = {
  type: CodEntryType;
  amountCents: number;
  debit: Account;
  credit: Account;
};

/**
 * Debit/credit pair for each checkpoint of §8.
 *
 * Read each line as "value moves from credit to debit". Cash collected at the
 * door moves out of CONSIGNEE_DUE and into RIDER_CASH; depositing it moves it
 * out of RIDER_CASH and into BRANCH_CASH; and so on to the merchant's bank.
 */
export function posting(
  type: CodEntryType,
  amountCents: number,
): Posting {
  if (!Number.isInteger(amountCents)) {
    throw new Error(`ledger amount must be integer cents, got ${amountCents}`);
  }
  if (amountCents <= 0) {
    // Direction is carried by the accounts, never by the sign. A negative
    // amount would let the same posting mean two different things.
    throw new Error(`ledger amount must be positive, got ${amountCents}`);
  }

  switch (type) {
    /** §8 checkpoint 1 — rider collects from consignee. */
    case "COLLECT":
      return { type, amountCents, debit: ACCOUNTS.RIDER_CASH, credit: ACCOUNTS.CONSIGNEE_DUE };
    /** §8 checkpoint 2 — rider deposits at branch/hub. */
    case "DEPOSIT":
      return { type, amountCents, debit: ACCOUNTS.BRANCH_CASH, credit: ACCOUNTS.RIDER_CASH };
    /** §8 checkpoint 3 — branch verifies and banks the cash. */
    case "BANK":
      return { type, amountCents, debit: ACCOUNTS.BANK, credit: ACCOUNTS.BRANCH_CASH };
    /**
     * The merchant's claim on banked cash, recognised per parcel at the moment
     * the branch banks it. This is the entry that makes §8's "banked vs
     * settled" comparison mean anything: until it is posted, the consignee's
     * credit is still sitting in CONSIGNEE_DUE and MERCHANT_PAYABLE is empty,
     * so a SETTLE would debit a liability that was never recognised and drive
     * the account the wrong way.
     */
    case "ACCRUE":
      return { type, amountCents, debit: ACCOUNTS.CONSIGNEE_DUE, credit: ACCOUNTS.MERCHANT_PAYABLE };
    /**
     * §8 checkpoint 5 — payout executed. The payable NatEx has been carrying
     * is discharged out of the bank.
     */
    case "SETTLE":
      return { type, amountCents, debit: ACCOUNTS.MERCHANT_PAYABLE, credit: ACCOUNTS.BANK };
    /**
     * A deduction. Taken out of what the merchant would otherwise receive and
     * recognised as NatEx income (§8: "Deductions modelled explicitly").
     */
    case "FEE":
      return { type, amountCents, debit: ACCOUNTS.MERCHANT_PAYABLE, credit: ACCOUNTS.FEE_INCOME };
    /**
     * A counted-vs-declared difference. Posted against BRANCH_CASH because the
     * count happens there: a shortfall means less cash arrived in the safe than
     * the rider said, and the difference is parked in CASH_VARIANCE until
     * someone explains it.
     */
    case "VARIANCE":
      return { type, amountCents, debit: ACCOUNTS.CASH_VARIANCE, credit: ACCOUNTS.BRANCH_CASH };
    case "TAX":
      return { type, amountCents, debit: ACCOUNTS.MERCHANT_PAYABLE, credit: ACCOUNTS.TAX_PAYABLE };
    /**
     * A reversal's legs are the mirror of the entry it corrects, so it is
     * built by `reverse()` from that entry rather than from its type alone.
     */
    case "REVERSAL":
      throw new Error("REVERSAL postings are built with reverse(), not posting()");
  }
}

/**
 * The correcting entry for a mistake.
 *
 * §8: "Append-only. Entries are never edited or deleted. Corrections are
 * reversal entries that reference the original." Swapping the legs makes the
 * pair sum to zero, so a corrected ledger still balances and the original
 * mistake stays visible in reconciliation.
 */
/**
 * The VARIANCE posting for a signed count difference (counted − expected).
 *
 * `posting("VARIANCE", n)` can only express a shortfall, because a chart of
 * accounts maps a type to a fixed pair of legs. A count can also come out
 * *over* — a rider hands in more than the parcels say — and that has to debit
 * the safe rather than credit it, or the banked cash will not tie out. So the
 * direction comes from the sign here, and the caller never has to think about
 * which leg is which.
 *
 * Returns null for a zero variance: a balanced count needs no entry at all,
 * and `posting()` rightly refuses to build a zero-amount row.
 */
export function variancePosting(signedCents: number): Posting | null {
  if (!Number.isInteger(signedCents)) {
    throw new Error(`variance must be whole cents, got ${signedCents}`);
  }
  if (signedCents === 0) return null;
  const short = posting("VARIANCE", Math.abs(signedCents));
  // Short: cash is missing from the safe → credit BRANCH_CASH (the default).
  // Over: extra cash arrived → mirror the legs so BRANCH_CASH is debited.
  return signedCents < 0 ? short : { ...short, debit: short.credit, credit: short.debit };
}

export function reverse(original: Posting): Posting {
  return {
    type: "REVERSAL",
    amountCents: original.amountCents,
    debit: original.credit,
    credit: original.debit,
  };
}

// ────────────────────────────────────────────────────────────── arithmetic

/** The minimum shape `balances()` needs — any ledger row satisfies it. */
export type LedgerLeg = {
  amountCents: number;
  debitAccount: string;
  creditAccount: string;
};

/**
 * Net balance of every account across the given entries.
 *
 * Sign convention: a debit adds, a credit subtracts. So RIDER_CASH comes out
 * positive while a rider holds cash, and CONSIGNEE_DUE comes out negative by
 * the same total — which is the double-entry identity the invariant job
 * asserts.
 */
export function balances(legs: readonly LedgerLeg[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const account of ALL_ACCOUNTS) out[account] = 0;
  for (const leg of legs) {
    out[leg.debitAccount] = (out[leg.debitAccount] ?? 0) + leg.amountCents;
    out[leg.creditAccount] = (out[leg.creditAccount] ?? 0) - leg.amountCents;
  }
  return out;
}

/**
 * Sum of every account balance. Must be exactly zero for any set of entries,
 * because each entry contributes `+amount` and `−amount`.
 *
 * A non-zero result means a row was written outside `posting()`/`reverse()` —
 * i.e. the ledger has been corrupted, not merely mis-reconciled.
 */
export function ledgerSum(legs: readonly LedgerLeg[]): number {
  let total = 0;
  for (const value of Object.values(balances(legs))) total += value;
  return total;
}

/**
 * §8's balance invariant, as a single number: Σ collected − Σ deposited.
 *
 * Computed from the entry types rather than from the RIDER_CASH account so
 * that it is an independent check — if the two ever disagree, the accounts
 * were posted wrongly, and `riderLiability` is the definition §8 gives.
 */
export function riderLiability(
  // `type` is read back from a text column, so it is typed as a plain string
  // here. Construction is where the union is enforced (`posting()`); reads
  // must tolerate whatever the table actually holds.
  entries: readonly { type: string; amountCents: number }[],
): number {
  let collected = 0;
  let deposited = 0;
  for (const entry of entries) {
    if (entry.type === "COLLECT") collected += entry.amountCents;
    else if (entry.type === "DEPOSIT") deposited += entry.amountCents;
    else if (entry.type === "REVERSAL") {
      // A reversal is already accounted for by the caller excluding the pair;
      // counting it here would double-correct. Reversed entries are filtered
      // out by `liveEntries()` before this function sees them.
      continue;
    }
  }
  return collected - deposited;
}

/**
 * Entries that still count, with each reversed entry and its reversal removed.
 *
 * Both remain in the table forever — §8 requires "both shown in
 * reconciliation" — but neither belongs in a balance.
 */
export function liveEntries<
  T extends { id: string; reversalOfId: string | null; reversedById: string | null },
>(entries: readonly T[]): T[] {
  const cancelled = new Set<string>();
  for (const entry of entries) {
    if (entry.reversalOfId) {
      cancelled.add(entry.id);
      cancelled.add(entry.reversalOfId);
    }
    if (entry.reversedById) cancelled.add(entry.id);
  }
  return entries.filter((entry) => !cancelled.has(entry.id));
}

/**
 * §8's four-way reconciliation: "collected vs deposited vs banked vs settled,
 * with variance highlighted at each stage."
 *
 * Each stage's variance is what has not yet moved to the next stage. That is
 * not automatically an error — cash collected this afternoon is legitimately
 * un-deposited — so the caller decides which gap is stale (the 48-hour control)
 * versus merely in flight.
 */
export type FourWay = {
  collectedCents: number;
  depositedCents: number;
  bankedCents: number;
  settledCents: number;
  /** Collected but not deposited — rider cash liability. */
  inRiderHandsCents: number;
  /** Deposited but not banked — sitting in branch safes. */
  inBranchSafeCents: number;
  /** Banked but not settled — NatEx holds the merchant's money. */
  awaitingSettlementCents: number;
};

export function fourWay(
  entries: readonly { type: string; amountCents: number }[],
): FourWay {
  let collected = 0;
  let deposited = 0;
  let banked = 0;
  let settled = 0;
  for (const entry of entries) {
    if (entry.type === "COLLECT") collected += entry.amountCents;
    else if (entry.type === "DEPOSIT") deposited += entry.amountCents;
    else if (entry.type === "BANK") banked += entry.amountCents;
    else if (entry.type === "SETTLE") settled += entry.amountCents;
  }
  return {
    collectedCents: collected,
    depositedCents: deposited,
    bankedCents: banked,
    settledCents: settled,
    inRiderHandsCents: collected - deposited,
    inBranchSafeCents: deposited - banked,
    awaitingSettlementCents: banked - settled,
  };
}

/**
 * What NatEx still owes a merchant, from the entries of that merchant alone.
 *
 * Σ ACCRUE − Σ (SETTLE + FEE + TAX): the claim recognised when their cash was
 * banked, less the payout, the deductions kept and any tax withheld. Zero once
 * a period is fully settled, and never negative unless a run paid out more
 * than was banked — which is exactly the condition a settlement must refuse.
 *
 * Computed from entry types, like `riderLiability()`, so it is an independent
 * check on the MERCHANT_PAYABLE account rather than a restatement of it.
 */
export function merchantPayable(
  entries: readonly { type: string; amountCents: number }[],
): number {
  let accrued = 0;
  let discharged = 0;
  for (const entry of entries) {
    if (entry.type === "ACCRUE") accrued += entry.amountCents;
    else if (entry.type === "SETTLE" || entry.type === "FEE" || entry.type === "TAX") {
      discharged += entry.amountCents;
    }
  }
  return accrued - discharged;
}

/**
 * Accounts that have gone negative when they must not.
 *
 * §8: "A negative balance is impossible by design and must trigger immediate
 * investigation." Returned rather than thrown, because the nightly job records
 * every breach it finds instead of stopping at the first.
 */
export function negativeBreaches(
  legs: readonly LedgerLeg[],
): { account: Account; balanceCents: number }[] {
  const table = balances(legs);
  const out: { account: Account; balanceCents: number }[] = [];
  for (const account of NON_NEGATIVE_ACCOUNTS) {
    const value = table[account] ?? 0;
    if (value < 0) out.push({ account, balanceCents: value });
  }
  return out;
}
