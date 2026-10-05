import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { eq, inArray, like, or } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

/**
 * End-to-end exercise of the Milestone 4 money API against a running dev server
 * (PROJECT.md §8 checkpoints 1–6, §10 M4, §11 problem+json, §5 row scoping).
 *
 * The module-level probes in scripts/tmp/ already prove the arithmetic. This
 * script proves the HTTP surface on top of it, which is what the probes cannot
 * reach: the role table, idempotency, merchant row scoping, and the fact that
 * every service the routes wrap is actually reachable over the wire with the
 * shapes the clients will see.
 *
 * Walks the real week: a rider collects three COD parcels, declares the cash,
 * the cashier counts it, the bank takes it, finance drafts the merchant's
 * settlement, a second pair of eyes approves it, the bank file goes out, the
 * UTR comes back — then the same merchant is invoiced for its charges, pays
 * part of it, and is credited for the rest.
 *
 * Every guardrail is asserted by trying to break it: ops attempting a cashier's
 * write, a rider declaring another rider's cash, a maker approving their own
 * run, a merchant reaching for another merchant's ledger, settlements and
 * invoices, and voiding an invoice that has already taken money.
 *
 * Self-contained and re-runnable: it owns a fixture merchant
 * (`mch_m4_smoke`) and wipes that merchant's money rows on every run, so it
 * neither depends on nor disturbs seeded or probe data. Requires a server on
 * :4200 and a seeded database (`bun run db:seed`).
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4200";
const SMOKE_MCH = "mch_m4_smoke";
const SEEDED_MCH = "mch_ceylon_threads";
const BRANCH = "brn_cmb_central";

const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { merchant } = await import("../src/api/database/schema/merchants");
const { rateLimit } = await import("../src/api/database/schema/shared");
const cod = await import("../src/api/database/schema/cod");
const { recordCollection } = await import("../src/api/modules/cod/service");
const { seedFinanceConfig } = await import("../src/api/modules/cod/config");
const { colomboToday, addDays } = await import("../src/api/shared/time");

let pass = 0;
const failures: string[] = [];
function ok(label: string, detail = ""): void {
  pass += 1;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label: string, detail: string): void {
  failures.push(`${label}: ${detail}`);
  console.log(`  FAIL  ${label} — ${detail}`);
}
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) ok(label, detail);
  else bad(label, detail || "assertion failed");
}
function errText(err: unknown): string {
  const e = err as { message?: string; data?: { status?: number; type?: string } };
  return `${e?.data?.status ?? ""} ${e?.data?.type ?? ""} ${e?.message ?? ""}`.trim();
}
/** §11: every refusal is problem+json, so the status is asserted, not the text. */
async function expectFail(label: string, status: number, fn: () => Promise<unknown>) {
  try {
    await fn();
    bad(label, "expected a rejection, got success");
  } catch (err) {
    const got = (err as { data?: { status?: number } }).data?.status;
    if (got === status) ok(label, `rejected ${errText(err)}`);
    else bad(label, `expected ${status}, got ${errText(err)}`);
  }
}

let keySeq = 0;
/** A fresh idempotency key per write (§4 requires one on every mutation). */
function key(label: string): string {
  keySeq += 1;
  return `m4-${label}-${Date.now()}-${keySeq}`;
}

function clientFor(token?: string, idemKey?: string): AppRouterClient {
  const link = new RPCLink({
    url: `${BASE}/api/rpc`,
    headers: () => ({
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idemKey ? { "idempotency-key": idemKey } : {}),
    }),
  });
  return createORPCClient(link);
}
const anon = clientFor();

async function login(phone: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.%Otp"));
  const challenge = await anon.identity.requestOtp({ phone });
  if (!challenge.devCode) throw new Error(`no dev OTP for ${phone}`);
  return finishMfa(BASE, await anon.identity.verifyOtp({ challengeId: challenge.challengeId, code: challenge.devCode, deviceId: null }));
}

// ── 0. Fixtures ───────────────────────────────────────────────────────────────
console.log(`\nNatEx M4 smoke test (COD ledger / settlement / invoicing) → ${BASE}\n`);
console.log("0. Fixtures");

await seedFinanceConfig();
await db
  .insert(merchant)
  .values({
    id: SMOKE_MCH,
    branchId: BRANCH,
    name: "M4 Smoke Traders",
    address: "1 Smoke Lane, Colombo 01",
    contactName: "Smoke Contact",
    contactPhone: "+94700000001",
  })
  .onConflictDoNothing();

// Wipe only this fixture merchant's money rows, so a re-run starts clean
// without touching seeded or probe data.
//
// CAREFUL — a COD posting chain is not all tagged with a merchant. A COLLECT
// entry carries merchantId; the DEPOSIT and BANK entries it rolls into carry
// merchantId NULL, because they are rider- and branch-level postings against
// several merchants' cash at once. Deleting only the merchant-tagged half
// leaves orphan DEPOSIT rows behind, and since riderLiability() is
// Σ COLLECT − Σ DEPOSIT (accounts.ts), the rider's liability goes NEGATIVE by
// one deposit on every re-run — which §8 calls impossible by design and which
// breaks the nightly invariant for every other probe sharing this rider.
// So the unit of deletion is the deposit chain, not the merchant row.
const priorEntries = await db
  .select({ id: cod.codEntry.id, depositId: cod.codEntry.depositId })
  .from(cod.codEntry)
  .where(eq(cod.codEntry.merchantId, SMOKE_MCH));
const priorEntryIds = priorEntries.map((r) => r.id);
if (priorEntryIds.length) {
  const items = await db
    .select({ depositId: cod.codDepositItem.depositId })
    .from(cod.codDepositItem)
    .where(inArray(cod.codDepositItem.entryId, priorEntryIds));
  const candidates = [
    ...new Set([
      ...items.map((i) => i.depositId),
      ...priorEntries.map((e) => e.depositId).filter((d): d is string => Boolean(d)),
    ]),
  ];
  // Only tear down a deposit this fixture owns outright. If a deposit also
  // banked another merchant's collection, deleting it would corrupt their
  // ledger — leave it and say so, rather than quietly widening the blast
  // radius.
  const shared: string[] = [];
  const mine: string[] = [];
  for (const depositId of candidates) {
    const attached = await db
      .select({ merchantId: cod.codEntry.merchantId })
      .from(cod.codEntry)
      .where(eq(cod.codEntry.depositId, depositId));
    const foreign = attached.some((a) => a.merchantId !== null && a.merchantId !== SMOKE_MCH);
    (foreign ? shared : mine).push(depositId);
  }
  if (shared.length) {
    console.log(`  NOTE  left ${shared.length} shared deposit(s) alone: ${shared.join(", ")}`);
  }
  if (mine.length) {
    // The DEPOSIT/BANK postings first — they are the rows the merchant filter
    // cannot see.
    await db.delete(cod.codEntry).where(inArray(cod.codEntry.depositId, mine));
    await db.delete(cod.codDepositItem).where(inArray(cod.codDepositItem.depositId, mine));
    await db.delete(cod.codDeposit).where(inArray(cod.codDeposit.id, mine));
  }
  await db.delete(cod.codDepositItem).where(inArray(cod.codDepositItem.entryId, priorEntryIds));
}
const priorSettlements = await db
  .select({ id: cod.codSettlement.id })
  .from(cod.codSettlement)
  .where(eq(cod.codSettlement.merchantId, SMOKE_MCH));
if (priorSettlements.length) {
  const ids = priorSettlements.map((r) => r.id);
  await db.delete(cod.codSettlementLine).where(inArray(cod.codSettlementLine.settlementId, ids));
  await db.delete(cod.codSettlement).where(inArray(cod.codSettlement.id, ids));
}
const priorInvoices = await db
  .select({ id: cod.codInvoice.id })
  .from(cod.codInvoice)
  .where(eq(cod.codInvoice.merchantId, SMOKE_MCH));
if (priorInvoices.length) {
  const ids = priorInvoices.map((r) => r.id);
  await db.delete(cod.codInvoiceLine).where(inArray(cod.codInvoiceLine.invoiceId, ids));
  await db.delete(cod.codCreditNote).where(inArray(cod.codCreditNote.invoiceId, ids));
  await db.delete(cod.codInvoice).where(inArray(cod.codInvoice.id, ids));
}
await db.delete(cod.codEntry).where(eq(cod.codEntry.merchantId, SMOKE_MCH));
await db.delete(cod.codHold).where(eq(cod.codHold.merchantId, SMOKE_MCH));
await db.delete(cod.codMerchantPayout).where(eq(cod.codMerchantPayout.merchantId, SMOKE_MCH));
await db
  .delete(cod.codOpsAlert)
  .where(or(eq(cod.codOpsAlert.merchantId, SMOKE_MCH), like(cod.codOpsAlert.sourceKey, "m4smoke%")));
ok("fixture merchant present and its money rows cleared", SMOKE_MCH);

// ── 1. Logins ─────────────────────────────────────────────────────────────────
console.log("\n1. Who is on shift (§6 role table)");
const rider = await login("+94771234567");
const ops = await login("+94772345678");
const maker = await login("+94774567890"); // finance
const checker = await login("+94773456789"); // admin — financeProc, different person
const merchantUser = await login("+94775678901"); // linked to the seeded merchant

const riderC = clientFor(rider.accessToken);
const opsC = clientFor(ops.accessToken);
const makerC = clientFor(maker.accessToken);
const merchC = clientFor(merchantUser.accessToken);

ok("rider", `${rider.user.name} (${rider.user.role})`);
ok("ops", `${ops.user.name} (${ops.user.role})`);
ok("finance maker", `${maker.user.name} (${maker.user.role})`);
ok("finance checker", `${checker.user.name} (${checker.user.role})`);
check(
  merchantUser.user.merchantId === SEEDED_MCH,
  "merchant principal is linked to its own merchant (§5 fixture)",
  `${merchantUser.user.name} → ${merchantUser.user.merchantId}`,
);
check(maker.user.id !== checker.user.id, "maker and checker are different people (§8)", `${maker.user.id} ≠ ${checker.user.id}`);

// ── 2. Collections ────────────────────────────────────────────────────────────
// Setup through the service, as the delivery module does on POD: the doorstep
// half of this chain is smoke-m3's job, not this script's.
console.log("\n2. COD collections on the doorstep (§8 checkpoint 1)");
const stamp = Date.now();
const collected: string[] = [];
let collectedCents = 0;
for (const [i, amount] of [450_000, 275_000, 180_000].entries()) {
  const res = await recordCollection({
    parcelId: `m4smoke-p${i + 1}-${stamp}`,
    awb: `M4SMK${stamp}${i + 1}`,
    merchantId: SMOKE_MCH,
    riderId: rider.user.id,
    branchId: BRANCH,
    amountCents: amount,
    mode: "cash",
    clientId: `m4smoke-${stamp}-${i + 1}`,
    actor: { userId: rider.user.id, name: rider.user.name, role: "rider", roles: ["rider"], branchId: BRANCH },
  });
  collected.push(res.entry.id);
  collectedCents += amount;
}
ok("three COD parcels collected", `${collected.length} entries, ${collectedCents / 100} LKR`);

const mine = await riderC.cod.myUndeposited({});
check(
  collected.every((id) => mine.some((e) => e.id === id)),
  "a rider reads their own undeposited cash over HTTP",
  `${mine.length} entries in hand`,
);
await expectFail("a rider may not read another rider's cash", 403, () =>
  riderC.cod.myUndeposited({ riderId: "usr_someone_else" }),
);

const ledger = await opsC.cod.entries({ merchantId: SMOKE_MCH, limit: 50 });
check(ledger.rows.length >= 3, "ops browses the ledger", `${ledger.total} entries for the fixture merchant`);

console.log("\n   §5 merchant row scoping");
const ownLedger = await merchC.cod.entries({ limit: 10 });
check(
  ownLedger.rows.every((e) => e.merchantId === SEEDED_MCH),
  "a merchant reading the ledger sees only its own rows",
  `${ownLedger.rows.length} rows, all ${SEEDED_MCH}`,
);
await expectFail("a merchant naming another merchant's ledger is refused, not re-scoped", 403, () =>
  merchC.cod.entries({ merchantId: SMOKE_MCH }),
);
await expectFail("a merchant cannot read the network reconciliation", 403, () => merchC.cod.reconciliation({}));

const recon = await opsC.cod.reconciliation({ merchantId: SMOKE_MCH });
ok("four-way reconciliation is reachable", JSON.stringify(recon).slice(0, 120));
const ceiling = await opsC.cod.cashCeiling({ riderId: rider.user.id });
ok("cash ceiling check is reachable", `liability ${ceiling.liabilityCents / 100} / ceiling ${ceiling.ceilingCents / 100} LKR`);

// ── 3. The cash comes in ──────────────────────────────────────────────────────
console.log("\n3. Deposit, count, bank (§8 checkpoints 2–3)");
await expectFail("a rider may not declare another rider's deposit", 403, () =>
  clientFor(rider.accessToken, key("wrong-rider")).cod.declareDeposit({
    riderId: "usr_someone_else",
    branchId: BRANCH,
    declaredCents: collectedCents,
    entryIds: collected,
  }),
);
await expectFail("ops declaring on a rider's behalf must name the rider", 400, () =>
  clientFor(ops.accessToken, key("unnamed-rider")).cod.declareDeposit({
    branchId: BRANCH,
    declaredCents: collectedCents,
    entryIds: collected,
  }),
);
await expectFail("a write without an idempotency key is refused (§4)", 400, () =>
  riderC.cod.declareDeposit({
    branchId: BRANCH,
    declaredCents: collectedCents,
    entryIds: collected,
  }),
);

const depositKey = key("declare");
const deposit = await clientFor(rider.accessToken, depositKey).cod.declareDeposit({
  branchId: BRANCH,
  declaredCents: collectedCents,
  entryIds: collected,
  note: "m4 smoke",
});
check(
  deposit.riderId === rider.user.id && deposit.expectedCents === collectedCents,
  "the rider declares the cash, and the rider is taken from the token",
  `${deposit.code}: declared ${deposit.declaredCents / 100}, expected ${deposit.expectedCents / 100} LKR`,
);
const replay = await clientFor(rider.accessToken, depositKey).cod.declareDeposit({
  branchId: BRANCH,
  declaredCents: collectedCents,
  entryIds: collected,
  note: "m4 smoke",
});
check(replay.id === deposit.id, "replaying the same idempotency key returns the first deposit", replay.code);

await expectFail("ops cannot verify a deposit — counting cash is finance's (§8)", 403, () =>
  clientFor(ops.accessToken, key("ops-verify")).cod.verifyDeposit({
    depositId: deposit.id,
    countedCents: collectedCents,
  }),
);
const verified = await clientFor(maker.accessToken, key("verify")).cod.verifyDeposit({
  depositId: deposit.id,
  countedCents: collectedCents,
});
check(
  verified.deposit.status === "verified" && verified.deposit.countedCents === collectedCents,
  "finance counts it and the deposit is verified",
  `counted ${verified.deposit.countedCents! / 100} LKR, variance ${verified.deposit.varianceCents ?? 0}`,
);

const banked = await clientFor(maker.accessToken, key("bank")).cod.bankDeposit({
  depositId: deposit.id,
  bankRef: `M4SMK-${stamp}`,
  bankAccount: "0012345678",
});
check(banked.deposit.status === "banked", "the cash reaches the bank", banked.deposit.code);
const afterBank = await opsC.cod.riderCash({ riderId: rider.user.id });
// §8: "A negative balance is impossible by design." Asserted, not merely
// printed — a negative here means postings were deleted or double-counted, and
// it is this script's own fixture wipe that is the likeliest culprit.
check(
  afterBank.liabilityCents >= 0,
  "the rider's cash liability is never negative (§8)",
  `${afterBank.liabilityCents / 100} LKR in hand`,
);

const stale = await opsC.cod.stale({});
ok("the >48h escalation list is reachable", `${stale.length} stale collections`);

// ── 4. Nightly invariant and the alert worklist ───────────────────────────────
console.log("\n4. Balance invariant and ops alerts (§8)");
const invariant = await clientFor(maker.accessToken, key("invariant")).cod.runInvariant({});
check(
  invariant.result === "ok" || invariant.result === "breached",
  "the nightly balance invariant runs on demand",
  `${invariant.result}: ${invariant.ridersChecked} riders, ${invariant.breaches.length} breach(es)`,
);
// The invariant history is finance's own record (routes/cod.ts: financeProc);
// ops learns about a breach through the alert worklist below, not from here.
const runs = await makerC.cod.invariantRuns({});
check(runs.length > 0, "past invariant runs are readable by finance", `${runs.length} runs on record`);
await expectFail("ops cannot read the invariant run history", 403, () => opsC.cod.invariantRuns({}));
const counts = await opsC.cod.alertCounts({});
ok("alert counts are reachable", JSON.stringify(counts).slice(0, 120));
const alertList = await opsC.cod.listAlerts({ status: ["open"] });
ok("the open alert worklist is reachable", `${alertList.length} open`);
await expectFail("a merchant cannot read the ops alert worklist", 403, () => merchC.cod.listAlerts({}));

// ── 5. Settlement ─────────────────────────────────────────────────────────────
console.log("\n5. The weekly settlement cycle (§8 checkpoints 4–6)");
const period = await makerC.finance.currentPeriod({});
check(
  addDays(period.periodEnd, -6) === period.periodStart,
  "the cycle is a seven-day window ending on the cut-off",
  `${period.periodStart} → ${period.periodEnd}, pays ${period.payoutDate}`,
);
// Today's collections fall in the period that ends at the NEXT cut-off, so the
// run is drafted as of that date rather than the last completed one.
const today = colomboToday();
const asOf = period.periodEnd === today ? today : addDays(period.periodEnd, 7);

await expectFail("a merchant cannot set its own bank details (§8 fraud surface)", 403, () =>
  clientFor(merchantUser.accessToken, key("merch-payout")).finance.setPayoutDetails({
    merchantId: SEEDED_MCH,
    beneficiaryName: "Me",
    bankName: "B",
    branchName: "C",
    accountNumber: "1",
  }),
);
const payout = await clientFor(maker.accessToken, key("payout")).finance.setPayoutDetails({
  merchantId: SMOKE_MCH,
  beneficiaryName: "M4 Smoke Traders",
  bankName: "Commercial Bank",
  branchName: "Colombo Fort",
  accountNumber: "8001234567",
  verified: true,
});
ok("finance records where the money goes", `${payout.beneficiaryName} @ ${payout.bankName}`);

const preview = await makerC.finance.settlementPreview({ merchantId: SMOKE_MCH, asOf });
check(
  preview.netCents > 0,
  "the preview shows what a run would pay, without creating one",
  `net ${preview.netCents / 100} LKR over ${preview.lines.length} lines`,
);

const created = await clientFor(maker.accessToken, key("stl-create")).finance.createSettlement({
  merchantId: SMOKE_MCH,
  asOf,
  deductions: [{ type: "penalty", amountCents: 5_000, description: "m4 smoke penalty" }],
});
const stlId = created.settlement.id;
check(
  created.settlement.status === "draft" && created.settlement.netCents > 0,
  "the maker drafts the run",
  `${created.settlement.code}: net ${created.settlement.netCents / 100} LKR`,
);
check(
  created.settlement.netCents === preview.netCents - 5_000,
  "the manual deduction lands on the run",
  `${preview.netCents / 100} − 50 = ${created.settlement.netCents / 100} LKR`,
);
await expectFail("a second open run on the same period is refused", 409, () =>
  clientFor(maker.accessToken, key("stl-dup")).finance.createSettlement({ merchantId: SMOKE_MCH, asOf }),
);

const proposed = await clientFor(maker.accessToken, key("stl-propose")).finance.proposeSettlement({ settlementId: stlId });
check(proposed.status === "proposed", "the run goes to a checker", proposed.code);
// settlement.ts raises maker-checker as a 403: it is a refusal of authority,
// not a state conflict. The problem type is what pins the reason down.
await expectFail("the maker cannot approve their own run (§8 maker–checker)", 403, () =>
  clientFor(maker.accessToken, key("stl-self")).finance.approveSettlement({ settlementId: stlId }),
);
await expectFail("ops cannot approve a payout at all", 403, () =>
  clientFor(ops.accessToken, key("stl-ops")).finance.approveSettlement({ settlementId: stlId }),
);
const approved = await clientFor(checker.accessToken, key("stl-approve")).finance.approveSettlement({ settlementId: stlId });
check(approved.status === "approved", "a second pair of eyes approves it", `${approved.code} by ${approved.approvedByName}`);

const csv = await clientFor(maker.accessToken, key("stl-csv")).finance.exportPayoutCsv({ settlementIds: [stlId] });
check(
  csv.csv.includes("8001234567") && csv.totalCents === approved.netCents,
  "the bank file carries the beneficiary and the exact net",
  `${csv.rows.length} row(s), ${csv.totalCents / 100} LKR`,
);
await expectFail("re-exporting the same run needs an explicit override", 409, () =>
  clientFor(maker.accessToken, key("stl-csv2")).finance.exportPayoutCsv({ settlementIds: [stlId] }),
);

const paid = await clientFor(checker.accessToken, key("stl-paid")).finance.recordPayout({
  settlementId: stlId,
  utr: `UTR-${stamp}`,
});
check(
  paid.settlement.status === "paid" && paid.settlement.utr === `UTR-${stamp}`,
  "the UTR comes back and the run is paid",
  `payable after: ${paid.payableAfterCents / 100} LKR`,
);

console.log("\n   settlement reads and scoping");
const stlRead = await makerC.finance.settlementById({ settlementId: stlId });
check(stlRead.balanced, "the run's lines still re-sum to its header", `derived net ${stlRead.derived.netCents / 100} LKR`);
await expectFail("a merchant cannot open another merchant's run", 403, () =>
  merchC.finance.settlementById({ settlementId: stlId }),
);
const merchStls = await merchC.finance.settlements({});
check(
  merchStls.every((s) => s.merchantId === SEEDED_MCH),
  "a merchant's settlement list is scoped to itself",
  `${merchStls.length} rows`,
);
const statement = await merchC.finance.statement({});
check(statement.merchantId === SEEDED_MCH, "a merchant reads its own statement", `payable ${statement.payableCents / 100} LKR`);
await expectFail("a merchant cannot read another merchant's statement", 403, () =>
  merchC.finance.statement({ merchantId: SMOKE_MCH }),
);
const due = await opsC.finance.settlementDue({ asOf });
ok("the settlement-due worklist is reachable", `${due.length} merchant(s) with money in the window`);

// ── 6. Holds ──────────────────────────────────────────────────────────────────
console.log("\n6. Settlement holds (§8 controls)");
const hold = await clientFor(maker.accessToken, key("hold")).finance.raiseHold({
  scope: "merchant",
  reason: "manual",
  merchantId: SMOKE_MCH,
  detail: "m4 smoke — payout frozen pending KYC re-check",
  sourceKey: `m4smoke:hold:${stamp}`,
});
check(hold.created && hold.hold.status === "open", "finance freezes a merchant's payout", hold.hold.id);
const state = await makerC.finance.holdState({ merchantId: SMOKE_MCH });
check(
  Array.isArray(state.heldParcelIds) && state.blockingHolds.length >= 1,
  "hold state crosses the wire as JSON, blocking holds included",
  `${state.blockingHolds.length} blocking, ${state.heldParcelIds.length} held parcels`,
);
await expectFail("ops cannot freeze a payout", 403, () =>
  clientFor(ops.accessToken, key("ops-hold")).finance.raiseHold({
    scope: "merchant",
    reason: "manual",
    merchantId: SMOKE_MCH,
    detail: "ops should not be able to do this",
  }),
);
const merchHolds = await merchC.finance.listHolds({});
check(
  merchHolds.every((h) => h.merchantId === SEEDED_MCH),
  "a merchant's hold list is scoped to itself",
  `${merchHolds.length} rows`,
);
const cleared = await clientFor(maker.accessToken, key("hold-clear")).finance.clearHold({
  holdId: hold.hold.id,
  note: "KYC re-checked, released",
});
check(cleared.status === "cleared", "clearing a hold needs a named human and a note", cleared.clearedByName ?? "");

// ── 7. Invoices and AR ────────────────────────────────────────────────────────
console.log("\n7. Invoicing and AR (§8)");
const charges = [
  { description: "Delivery charge — m4 smoke", unitCents: 90_000, quantity: 3 },
  { description: "Fuel surcharge — m4 smoke", unitCents: 30_000 },
];
const invPreview = await makerC.finance.invoicePreview({ merchantId: SMOKE_MCH, charges, asOf });
check(invPreview.totalCents > 0, "the invoice preview prices the period", `${invPreview.totalCents / 100} LKR`);

const invCreated = await clientFor(maker.accessToken, key("inv-create")).finance.createInvoice({
  merchantId: SMOKE_MCH,
  charges,
  asOf,
});
const invId = invCreated.invoice.id;
check(
  invCreated.invoice.status === "draft" && invCreated.lines.length >= 2,
  "the invoice is drafted",
  `${invCreated.invoice.code}: ${invCreated.invoice.totalCents / 100} LKR over ${invCreated.lines.length} lines`,
);
await expectFail("a second invoice for the same period is refused", 409, () =>
  clientFor(maker.accessToken, key("inv-dup")).finance.createInvoice({ merchantId: SMOKE_MCH, charges, asOf }),
);
await expectFail("a merchant cannot invoice itself", 403, () =>
  clientFor(merchantUser.accessToken, key("merch-inv")).finance.createInvoice({ merchantId: SEEDED_MCH, charges }),
);

const issued = await clientFor(maker.accessToken, key("inv-issue")).finance.issueInvoice({ invoiceId: invId, asOf });
// This invoice prices charges already recovered from COD, so invoicing.ts's
// settledStatus() opens it as part_paid rather than issued — the recovered
// amount was never a receivable (see that file's header). Either is correct
// here; what must be true is that the credit clock started.
check(
  (issued.status === "issued" || issued.status === "part_paid") && Boolean(issued.dueDate),
  "issuing it starts the credit clock",
  `${issued.status}, due ${issued.dueDate}, ${issued.recoveredCents / 100} LKR already recovered`,
);

const partial = Math.floor(issued.totalCents / 3);
const payment = await clientFor(maker.accessToken, key("inv-pay")).finance.recordInvoicePayment({
  invoiceId: invId,
  amountCents: partial,
  reference: `RCPT-${stamp}`,
});
check(
  payment.invoice.status === "part_paid" && payment.invoice.paidCents === partial,
  "a part payment is applied and the status follows",
  `${payment.invoice.paidCents / 100} of ${payment.invoice.totalCents / 100} LKR`,
);
await expectFail("an invoice that has taken money cannot be voided (§11)", 409, () =>
  clientFor(maker.accessToken, key("inv-void")).finance.voidInvoice({ invoiceId: invId, reason: "changed my mind" }),
);

const credit = await clientFor(maker.accessToken, key("inv-credit")).finance.issueCreditNote({
  invoiceId: invId,
  amountCents: 20_000,
  reason: "m4 smoke goodwill credit",
});
check(
  credit.invoice.creditedCents === 20_000,
  "an issued invoice is credited, never edited",
  `${credit.creditNote.code ?? credit.creditNote.id}: ${credit.invoice.creditedCents / 100} LKR`,
);
const invRead = await makerC.finance.invoiceById({ invoiceId: invId });
check(
  invRead.outstandingCents ===
    invRead.invoice.totalCents - partial - 20_000 - invRead.invoice.recoveredCents,
  "outstanding is total less paid, credited and already-recovered (§8)",
  `${invRead.outstandingCents / 100} LKR outstanding, ${invRead.invoice.recoveredCents / 100} recovered`,
);
check(invRead.balanced, "the invoice's lines re-sum to its header", `derived ${invRead.derived.totalCents / 100} LKR`);

await expectFail("a merchant cannot open another merchant's invoice", 403, () =>
  merchC.finance.invoiceById({ invoiceId: invId }),
);
const merchInvs = await merchC.finance.invoices({});
check(
  merchInvs.every((i) => i.merchantId === SEEDED_MCH),
  "a merchant's invoice list is scoped to itself",
  `${merchInvs.length} rows`,
);
const ageing = await opsC.finance.arAgeing({ merchantId: SMOKE_MCH });
check(
  ageing.outstandingCents >= invRead.outstandingCents,
  "network AR ageing is a staff report and counts this invoice",
  `${ageing.outstandingCents / 100} LKR across ${ageing.rows.length} row(s)`,
);
await expectFail("a merchant cannot read the network AR report", 403, () => merchC.finance.arAgeing({}));
const myAr = await merchC.finance.merchantAr({});
check(myAr.merchantId === SEEDED_MCH, "a merchant reads its own AR", `${myAr.outstandingCents / 100} LKR outstanding`);
const myPayable = await merchC.finance.payable({});
ok("a merchant reads its own payable balance", `${myPayable / 100} LKR`);
const myPayoutDetails = await merchC.finance.payoutDetails({});
ok("a merchant reads its own bank details", myPayoutDetails ? myPayoutDetails.beneficiaryName : "none on file");

// ── 8. What this script leaves behind ─────────────────────────────────────────
// The probes in scripts/tmp/ each end by asserting §8's invariant across the
// whole ledger, so a smoke run that leaves the ledger unbalanced fails THEM,
// several scripts away from the cause. Assert it here instead, where the
// culprit is one screen up.
console.log("\n8. The ledger this script leaves behind (§8)");
const closing = await clientFor(maker.accessToken, key("closing-invariant")).cod.runInvariant({});
check(
  closing.result === "ok",
  "the ledger still satisfies the nightly balance invariant",
  closing.result === "ok"
    ? `${closing.ridersChecked} riders, Σcollected−Σdeposited = ${closing.riderLiabilityCents / 100} LKR`
    : `${closing.breaches.length} breach(es): ${JSON.stringify(closing.breaches).slice(0, 200)}`,
);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(72)}`);
if (failures.length === 0) {
  console.log(`M4 smoke: ${pass}/${pass} checks passed.\n`);
  process.exit(0);
}
console.log(`M4 smoke: ${pass} passed, ${failures.length} FAILED:`);
for (const f of failures) console.log(`  - ${f}`);
console.log();
process.exit(1);
