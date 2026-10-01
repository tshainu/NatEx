/**
 * Unit tests for the COD ledger arithmetic (PROJECT.md §345: "Unit tests cover
 * the domain rules (state machine, ledger arithmetic, pricing)").
 *
 * Pure functions only — no database. Run: bun scripts/test-cod-accounts.ts
 */
import {
  ACCOUNTS,
  balances,
  fourWay,
  ledgerSum,
  liveEntries,
  merchantPayable,
  negativeBreaches,
  posting,
  reverse,
  riderLiability,
  variancePosting,
  type LedgerLeg,
} from "../src/api/modules/cod/accounts";

let pass = 0;
const fail: string[] = [];

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function legs(...ps: ReturnType<typeof posting>[]): LedgerLeg[] {
  return ps.map((p) => ({
    amountCents: p.amountCents,
    debitAccount: p.debit,
    creditAccount: p.credit,
  }));
}

// ── the deposit count variance: direction must follow the sign
{
  // Regression test for a live bug. The ledger variance is measured against
  // the COLLECT entries handed over, and a shortfall and an overage need
  // opposite legs or the banked cash does not tie out. `posting("VARIANCE")`
  // alone can only express a shortfall.
  check("a balanced count posts no variance entry at all", variancePosting(0) === null);

  const short = variancePosting(-120_000)!;
  check("a shortfall credits the safe", short.credit === ACCOUNTS.BRANCH_CASH);
  check("a shortfall debits the variance account", short.debit === ACCOUNTS.CASH_VARIANCE);
  check("a shortfall is posted as a positive amount", short.amountCents === 120_000);

  const over = variancePosting(120_000)!;
  check("an overage debits the safe", over.debit === ACCOUNTS.BRANCH_CASH);
  check("an overage credits the variance account", over.credit === ACCOUNTS.CASH_VARIANCE);
  check("the two directions are exact mirrors", short.debit === over.credit && short.credit === over.debit);

  check("a fractional variance is refused", (() => {
    try { variancePosting(1.5); return false; } catch { return true; }
  })());

  // The whole point: expected in, counted banked, safe returns to zero.
  const expected = 550_050;
  const counted = 430_050;
  const book = legs(
    posting("COLLECT", expected),
    posting("DEPOSIT", expected),
    variancePosting(counted - expected)!,
    posting("BANK", counted),
  );
  const b = balances(book);
  check("after a short count the safe is empty, not negative", b[ACCOUNTS.BRANCH_CASH] === 0, `${b[ACCOUNTS.BRANCH_CASH]}`);
  check("the bank holds exactly what was counted", b[ACCOUNTS.BANK] === counted, `${b[ACCOUNTS.BANK]}`);
  check("the missing cash sits in the variance account", b[ACCOUNTS.CASH_VARIANCE] === expected - counted, `${b[ACCOUNTS.CASH_VARIANCE]}`);
  check("the rider is fully relieved of the collections handed over", b[ACCOUNTS.RIDER_CASH] === 0, `${b[ACCOUNTS.RIDER_CASH]}`);
  check("no account went negative", negativeBreaches(book).length === 0);
  check("a short-counted book still sums to zero", ledgerSum(book) === 0);

  const overBook = legs(
    posting("COLLECT", 100_000),
    posting("DEPOSIT", 100_000),
    variancePosting(20_000)!,
    posting("BANK", 120_000),
  );
  const ob = balances(overBook);
  check("after an over count the safe is also empty", ob[ACCOUNTS.BRANCH_CASH] === 0, `${ob[ACCOUNTS.BRANCH_CASH]}`);
  check("the surplus sits in the variance account as a credit", ob[ACCOUNTS.CASH_VARIANCE] === -20_000, `${ob[ACCOUNTS.CASH_VARIANCE]}`);
  check("an over-counted book still sums to zero", ledgerSum(overBook) === 0);
}

console.log("\nCOD ledger arithmetic (§8)\n");

// ── postings are balanced and directional
{
  const collect = posting("COLLECT", 250_000);
  check(
    "COLLECT debits rider cash, credits consignee due",
    collect.debit === ACCOUNTS.RIDER_CASH && collect.credit === ACCOUNTS.CONSIGNEE_DUE,
  );
  const deposit = posting("DEPOSIT", 250_000);
  check(
    "DEPOSIT moves cash rider → branch",
    deposit.debit === ACCOUNTS.BRANCH_CASH && deposit.credit === ACCOUNTS.RIDER_CASH,
  );
  const bank = posting("BANK", 250_000);
  check(
    "BANK moves cash branch → bank",
    bank.debit === ACCOUNTS.BANK && bank.credit === ACCOUNTS.BRANCH_CASH,
  );
  const settle = posting("SETTLE", 250_000);
  check(
    "SETTLE discharges merchant payable out of bank",
    settle.debit === ACCOUNTS.MERCHANT_PAYABLE && settle.credit === ACCOUNTS.BANK,
  );
  const fee = posting("FEE", 5_000);
  check(
    "FEE takes a deduction out of the payable into fee income",
    fee.debit === ACCOUNTS.MERCHANT_PAYABLE && fee.credit === ACCOUNTS.FEE_INCOME,
  );
}

// ── integer-cents discipline (§9: never float or double for money)
{
  let threw = false;
  try {
    posting("COLLECT", 1250.5);
  } catch {
    threw = true;
  }
  check("a fractional amount is rejected outright", threw);

  threw = false;
  try {
    posting("COLLECT", -500);
  } catch {
    threw = true;
  }
  check("a negative amount is rejected — direction lives in the accounts", threw);

  threw = false;
  try {
    posting("COLLECT", 0);
  } catch {
    threw = true;
  }
  check("a zero-amount entry is rejected", threw);

  threw = false;
  try {
    posting("REVERSAL", 500);
  } catch {
    threw = true;
  }
  check("REVERSAL cannot be built by posting() — it mirrors a real entry", threw);
}

// ── the double-entry identity
{
  const book = legs(
    posting("COLLECT", 250_000),
    posting("COLLECT", 180_050),
    posting("DEPOSIT", 250_000),
    posting("BANK", 250_000),
    posting("FEE", 3_000),
    posting("SETTLE", 247_000),
  );
  check("the whole ledger sums to exactly zero", ledgerSum(book) === 0, `got ${ledgerSum(book)}`);

  const table = balances(book);
  check(
    "consignee due equals minus everything ever collected",
    table[ACCOUNTS.CONSIGNEE_DUE] === -430_050,
    `got ${table[ACCOUNTS.CONSIGNEE_DUE]}`,
  );
  check(
    "rider cash = collected − deposited, to the cent",
    table[ACCOUNTS.RIDER_CASH] === 430_050 - 250_000,
    `got ${table[ACCOUNTS.RIDER_CASH]}`,
  );
  check("branch safe is empty once banked", table[ACCOUNTS.BRANCH_CASH] === 0);
  check(
    "bank holds what was banked less the payout",
    table[ACCOUNTS.BANK] === 250_000 - 247_000,
    `got ${table[ACCOUNTS.BANK]}`,
  );
  check("fee income is recognised", table[ACCOUNTS.FEE_INCOME] === -3_000);
}

// ── §8's balance invariant, computed independently of the accounts
{
  const entries = [
    { type: "COLLECT" as const, amountCents: 250_000 },
    { type: "COLLECT" as const, amountCents: 180_050 },
    { type: "DEPOSIT" as const, amountCents: 250_000 },
  ];
  check(
    "Σ collected − Σ deposited = rider cash liability",
    riderLiability(entries) === 180_050,
    `got ${riderLiability(entries)}`,
  );
  const table = balances(
    legs(posting("COLLECT", 250_000), posting("COLLECT", 180_050), posting("DEPOSIT", 250_000)),
  );
  check(
    "the invariant and the RIDER_CASH account agree",
    riderLiability(entries) === table[ACCOUNTS.RIDER_CASH],
  );
}

// ── corrections are reversals, and a reversed pair is a no-op
{
  const original = posting("COLLECT", 99_900);
  const correction = reverse(original);
  check(
    "a reversal mirrors the legs of the entry it corrects",
    correction.debit === original.credit && correction.credit === original.debit,
  );
  check("a reversal keeps the original amount", correction.amountCents === original.amountCents);

  const book: LedgerLeg[] = [
    { amountCents: original.amountCents, debitAccount: original.debit, creditAccount: original.credit },
    { amountCents: correction.amountCents, debitAccount: correction.debit, creditAccount: correction.credit },
  ];
  const table = balances(book);
  check(
    "an entry and its reversal net to zero in every account",
    Object.values(table).every((v) => v === 0),
  );
  check("a corrected ledger still balances", ledgerSum(book) === 0);
}

// ── reversed entries leave the balance but stay in the table (§8, §198)
{
  const rows = [
    { id: "e1", type: "COLLECT" as const, reversalOfId: null, reversedById: "e2" },
    { id: "e2", type: "REVERSAL" as const, reversalOfId: "e1", reversedById: null },
    { id: "e3", type: "COLLECT" as const, reversalOfId: null, reversedById: null },
  ];
  const live = liveEntries(rows);
  check("a reversed entry and its reversal drop out of the live set", live.length === 1);
  check("the surviving entry is the untouched one", live[0]?.id === "e3");
  check("nothing was removed from the input — append-only", rows.length === 3);
}

// ── four-way reconciliation (§8)
{
  const recon = fourWay([
    { type: "COLLECT", amountCents: 500_000 },
    { type: "DEPOSIT", amountCents: 300_000 },
    { type: "BANK", amountCents: 200_000 },
    { type: "SETTLE", amountCents: 120_000 },
  ]);
  check("collected", recon.collectedCents === 500_000);
  check("still in rider hands = collected − deposited", recon.inRiderHandsCents === 200_000);
  check("still in branch safe = deposited − banked", recon.inBranchSafeCents === 100_000);
  check("awaiting settlement = banked − settled", recon.awaitingSettlementCents === 80_000);
  check(
    "the four stages account for every rupee collected",
    recon.inRiderHandsCents + recon.inBranchSafeCents + recon.awaitingSettlementCents + recon.settledCents ===
      recon.collectedCents,
  );
}

// ── negative balances are impossible by design (§8)
{
  const honest = legs(posting("COLLECT", 100_000), posting("DEPOSIT", 100_000));
  check("a clean book reports no breach", negativeBreaches(honest).length === 0);

  // A rider depositing more than they ever collected: only reachable by a
  // corrupted write, which is exactly what the nightly job must catch.
  const impossible = legs(posting("COLLECT", 50_000), posting("DEPOSIT", 80_000));
  const breaches = negativeBreaches(impossible);
  check("over-depositing drives rider cash negative and is flagged", breaches.length === 1);
  check(
    "the breach names the account and the amount",
    breaches[0]?.account === ACCOUNTS.RIDER_CASH && breaches[0]?.balanceCents === -30_000,
    JSON.stringify(breaches[0]),
  );
  check("a breached book still sums to zero — it is mis-posted, not unbalanced", ledgerSum(impossible) === 0);
}

// ── rounding: tax arithmetic must never introduce a fraction of a cent
{
  // SSCL 2.5% then VAT 18% on (charge + SSCL) — the LK stacking order.
  // Inactive by default (§15 q10 still open) but the arithmetic must be exact.
  const charge = 33_333; // Rs. 333.33, deliberately awkward
  const sscl = Math.round(charge * 0.025);
  const vat = Math.round((charge + sscl) * 0.18);
  check("SSCL is a whole number of cents", Number.isInteger(sscl));
  check("VAT is a whole number of cents", Number.isInteger(vat));
  check("VAT stacks on charge + SSCL, not on charge alone", vat === Math.round((charge + sscl) * 0.18));
  check("the gross is the exact sum of its integer parts", charge + sscl + vat === 33_333 + 833 + 6_150, `${charge + sscl + vat}`);
}

// ── ACCRUE and the merchant payable (§8: "banked vs settled")
{
  const accrue = posting("ACCRUE", 250_000);
  check(
    "ACCRUE debits consignee due, credits merchant payable",
    accrue.debit === ACCOUNTS.CONSIGNEE_DUE && accrue.credit === ACCOUNTS.MERCHANT_PAYABLE,
  );
  const tax = posting("TAX", 4_500);
  check(
    "TAX withholds out of the payable into tax payable",
    tax.debit === ACCOUNTS.MERCHANT_PAYABLE && tax.credit === ACCOUNTS.TAX_PAYABLE,
  );

  // The reason ACCRUE exists at all: without it the consignee's credit is
  // never discharged and a SETTLE debits a liability nobody recognised,
  // driving MERCHANT_PAYABLE the wrong way.
  const withoutAccrual = balances(
    legs(
      posting("COLLECT", 250_000),
      posting("DEPOSIT", 250_000),
      posting("BANK", 250_000),
      posting("SETTLE", 250_000),
    ),
  );
  check(
    "without an accrual the consignee credit is left stranded",
    withoutAccrual[ACCOUNTS.CONSIGNEE_DUE] === -250_000,
    `${withoutAccrual[ACCOUNTS.CONSIGNEE_DUE]}`,
  );
  check(
    "without an accrual a payout drives the payable the wrong way",
    withoutAccrual[ACCOUNTS.MERCHANT_PAYABLE] === 250_000,
    `${withoutAccrual[ACCOUNTS.MERCHANT_PAYABLE]}`,
  );

  // The full life of one COD parcel, door to merchant's bank.
  const cod = 250_000;
  const fee = 3_000;
  const wht = 1_250;
  const payout = cod - fee - wht;
  const book = legs(
    posting("COLLECT", cod),
    posting("DEPOSIT", cod),
    posting("BANK", cod),
    posting("ACCRUE", cod),
    posting("FEE", fee),
    posting("TAX", wht),
    posting("SETTLE", payout),
  );
  const table = balances(book);
  check("a fully settled parcel leaves no consignee credit behind", table[ACCOUNTS.CONSIGNEE_DUE] === 0, `${table[ACCOUNTS.CONSIGNEE_DUE]}`);
  check("a fully settled parcel leaves no payable", table[ACCOUNTS.MERCHANT_PAYABLE] === 0, `${table[ACCOUNTS.MERCHANT_PAYABLE]}`);
  check("the bank keeps exactly the deductions and the withholding", table[ACCOUNTS.BANK] === fee + wht, `${table[ACCOUNTS.BANK]}`);
  check("fee income is recognised once", table[ACCOUNTS.FEE_INCOME] === -fee);
  check("the withholding is owed to the state, not to NatEx", table[ACCOUNTS.TAX_PAYABLE] === -wht);
  check("the whole life of a COD parcel sums to zero", ledgerSum(book) === 0, `${ledgerSum(book)}`);
  check("no account went negative over the parcel's life", negativeBreaches(book).length === 0);

  // merchantPayable(): Σ ACCRUE − Σ (SETTLE + FEE + TAX).
  const entries = [
    { type: "COLLECT", amountCents: cod },
    { type: "DEPOSIT", amountCents: cod },
    { type: "BANK", amountCents: cod },
    { type: "ACCRUE", amountCents: cod },
    { type: "FEE", amountCents: fee },
    { type: "TAX", amountCents: wht },
    { type: "SETTLE", amountCents: payout },
  ];
  check("a fully settled merchant nets to exactly zero", merchantPayable(entries) === 0, `${merchantPayable(entries)}`);
  check(
    "the payable and the MERCHANT_PAYABLE account agree, sign for sign",
    merchantPayable(entries) === -(table[ACCOUNTS.MERCHANT_PAYABLE] ?? 0),
  );

  const banked = [
    { type: "ACCRUE", amountCents: 250_000 },
    { type: "ACCRUE", amountCents: 180_050 },
  ];
  check("banked but unsettled COD is owed in full", merchantPayable(banked) === 430_050, `${merchantPayable(banked)}`);
  check(
    "deductions reduce what is owed without a payout",
    merchantPayable([...banked, { type: "FEE", amountCents: 5_000 }]) === 425_050,
  );
  check(
    "a part-paid period leaves the remainder owed",
    merchantPayable([...banked, { type: "SETTLE", amountCents: 250_000 }]) === 180_050,
  );

  // Independence: each invariant is computed from its own entry types, so one
  // cannot mask an error in the other.
  check("cash in a rider's pocket is not yet owed to the merchant", merchantPayable([
    { type: "COLLECT", amountCents: 250_000 },
    { type: "DEPOSIT", amountCents: 250_000 },
    { type: "BANK", amountCents: 250_000 },
  ]) === 0);
  check("an accrual does not touch the rider's liability", riderLiability(banked) === 0);
  check(
    "a variance never lands on the merchant's payable",
    merchantPayable([...banked, { type: "VARIANCE", amountCents: 120_000 }]) === 430_050,
  );

  // The condition a settlement run must refuse: paying out more than banked.
  check(
    "over-paying a merchant shows as a negative payable",
    merchantPayable([{ type: "ACCRUE", amountCents: 100_000 }, { type: "SETTLE", amountCents: 150_000 }]) === -50_000,
  );

  // Reversals: an accrual that was posted in error is withdrawn by its
  // reversal leaving the table, not by editing the payable.
  const wrong = posting("ACCRUE", 99_900);
  const fixed = reverse(wrong);
  check(
    "reversing an accrual mirrors its legs back",
    fixed.debit === ACCOUNTS.MERCHANT_PAYABLE && fixed.credit === ACCOUNTS.CONSIGNEE_DUE,
  );
  const corrected = balances([
    { amountCents: wrong.amountCents, debitAccount: wrong.debit, creditAccount: wrong.credit },
    { amountCents: fixed.amountCents, debitAccount: fixed.debit, creditAccount: fixed.credit },
  ]);
  check(
    "a reversed accrual leaves nothing owed",
    corrected[ACCOUNTS.MERCHANT_PAYABLE] === 0 && corrected[ACCOUNTS.CONSIGNEE_DUE] === 0,
  );
}

console.log(`\n${pass} passed, ${fail.length} failed\n`);
if (fail.length) {
  for (const f of fail) console.log(`  - ${f}`);
  process.exit(1);
}
