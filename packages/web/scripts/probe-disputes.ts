/**
 * Disputes and the claim register — live probe (PROJECT.md §10 M4 "disputes",
 * §8 settlement holds and maker–checker, §5 merchant scoping).
 *
 * Nothing mocked: real API on :4200, real database.
 *
 *   1. caps: a loss/damage claim is capped at the declared value, a COD
 *      shortfall at the COD amount; both are snapshotted on open
 *   2. a money dispute raises a parcel hold; a billing dispute does not
 *   3. one live case per parcel and type
 *   4. §5: a merchant naming another merchant is 403; another merchant's case
 *      or parcel by id/AWB is 404; lists are pinned to the merchant
 *   5. maker–checker: the opener cannot decide
 *   6. remedies: credit note against an issued invoice of the same merchant,
 *      bank transfer with a UTR; the hold is released on decision/withdrawal
 *   7. the outbox turns `cod.dispute_opened` into a finance alert
 *   8. register view and counts
 *
 *   bun --env-file=../../.env scripts/probe-disputes.ts
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { and, eq, inArray, like, ne, sql } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";
import { CMB_BRANCH } from "./lib/rail";

const API = process.env.PROBE_API ?? "http://localhost:4200";
const MERCHANT = "mch_ceylon_threads";
const OTHER = "mch_lanka_gadgets";

const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const cod = await import("../src/api/database/schema/cod");
const { parcel: parcelTable } = await import("../src/api/database/schema/parcels");
await db.delete(rateLimit);

const RUN = `DP${Date.now().toString(36).toUpperCase().slice(-5)}`;
let keySeq = 0;
const key = (l: string) => `disputes-${RUN}-${l}-${++keySeq}`;
function clientFor(token?: string, idem?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${API}/api/rpc`,
      headers: () => ({
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idem ? { "idempotency-key": idem } : {}),
      }),
    }),
  );
}
const anon = clientFor();

let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${label}: ${detail || "assertion failed"}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
async function refusal(p: Promise<unknown>): Promise<{ status: number; type: string; detail: string }> {
  try {
    await p;
    return { status: 200, type: "", detail: "accepted" };
  } catch (e) {
    const err = e as { status?: number; data?: { detail?: string; type?: string }; message?: string };
    return {
      status: err.status ?? 0,
      type: (err.data?.type ?? "").split("/").pop() ?? "",
      detail: err.data?.detail ?? err.message ?? String(e),
    };
  }
}
async function login(phone: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return finishMfa(API, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: null }));
}
const holdRow = async (id: string | null) =>
  id ? (await db.select().from(cod.codHold).where(eq(cod.codHold.id, id)))[0] : undefined;

console.log(`\nNatEx disputes probe (${RUN}) → ${API}\n`);
console.log("0. Staging");
const admin = await login("+94773456789");
const finance = await login("+94774567890");
const ops = await login("+94772345678");
const merchant = await login("+94775678901");
const rider = await login("+94778901234");
check(merchant.user.merchantId === MERCHANT, "merchant user is Ceylon Threads", String(merchant.user.merchantId));

const m = (l: string) => clientFor(merchant.accessToken, key(l));
const f = (l: string) => clientFor(finance.accessToken, key(l));
const a = (l: string) => clientFor(admin.accessToken, key(l));
const mr = clientFor(merchant.accessToken);
const fr = clientFor(finance.accessToken);

const book = async (slot: string, declared: number, codAmt: number, who = MERCHANT) =>
  (
    await a(`book-${slot}`).parcels.create({
      merchantId: who,
      branchId: CMB_BRANCH,
      weightGrams: 900,
      declaredValueCents: declared,
      codAmountCents: codAmt,
      originAddress: "12 Galle Road, Colombo 03",
      consigneeName: `${RUN} ${slot}`,
      consigneePhone: "+94761112233",
      destAddress: "45 Duplication Road, Colombo 04",
    })
  ).parcel;
const pLoss = await book("Loss", 500_000, 0); // Rs 5,000 declared, prepaid
const pCod = await book("Cod", 300_000, 240_000); // Rs 2,400 COD
const pDmg = await book("Dmg", 800_000, 0);
const pOther = await book("Other", 100_000, 0, OTHER);
check(Boolean(pLoss.awb && pCod.awb && pDmg.awb && pOther.awb), "four parcels booked", [pLoss.awb, pCod.awb, pDmg.awb, pOther.awb].join(", "));

// ── 1. caps and snapshots ───────────────────────────────────────────────────
console.log("\n1. Caps (declared value, COD amount) and snapshots");
let r = await refusal(
  m("loss-over").disputes.open({ awb: pLoss.awb, type: "loss", claimAmountCents: 500_001, description: `${RUN} lost in transit, over cap` }),
);
check(r.status === 400 && r.type === "claim-exceeds-cap", "a loss claim one cent over the declared value is refused", `${r.status} ${r.type}`);
r = await refusal(
  m("cod-over").disputes.open({ awb: pCod.awb, type: "cod_shortfall", claimAmountCents: 240_001, description: `${RUN} short remittance, over cap` }),
);
check(r.status === 400 && r.type === "claim-exceeds-cap", "a COD shortfall one cent over the COD is refused", `${r.status} ${r.type}`);
r = await refusal(
  m("cod-prepaid").disputes.open({ awb: pLoss.awb, type: "cod_shortfall", claimAmountCents: 100, description: `${RUN} prepaid parcel cod claim` }),
);
check(r.status === 400, "a COD shortfall on a prepaid parcel is refused", r.detail);
r = await refusal(m("no-awb").disputes.open({ type: "loss", claimAmountCents: 100, description: `${RUN} loss without a parcel` }));
check(r.status === 400, "a loss claim must name an AWB", r.detail);

const loss = await m("loss").disputes.open({
  awb: pLoss.awb,
  type: "loss",
  claimAmountCents: 500_000,
  description: `${RUN} parcel never arrived; consignee confirms non-receipt`,
});
check(loss.code.startsWith("CLM") && loss.status === "open", "a loss claim at exactly the cap opens as a CLM case", loss.code);
check(loss.declaredValueCents === 500_000 && loss.codAmountCents === 0, "declared value and COD are snapshotted", `${loss.declaredValueCents}/${loss.codAmountCents}`);
check(loss.merchantId === MERCHANT && loss.openedByRole === "merchant", "pinned to the merchant's own account", loss.merchantId);
check(Boolean(loss.slaDueAt) && new Date(loss.slaDueAt!).getTime() > Date.now() + 4 * 86_400_000, "an SLA clock is set (5 days)", String(loss.slaDueAt));

// the parcel is edited after open; the snapshot must not move
await db.update(parcelTable).set({ declaredValueCents: 1 }).where(eq(parcelTable.id, pLoss.id));
const lossReread = await mr.disputes.get({ disputeId: loss.id });
check(lossReread.declaredValueCents === 500_000, "a later edit to the parcel leaves the snapshot alone", `${lossReread.declaredValueCents}`);

const short = await m("short").disputes.open({
  awb: pCod.awb,
  type: "cod_shortfall",
  claimAmountCents: 40_000,
  description: `${RUN} remitted Rs 2,000 against Rs 2,400 COD`,
});
check(short.code.startsWith("DSP") && short.codAmountCents === 240_000, "a COD shortfall opens as DSP with the COD snapshotted", short.code);

// ── 2. holds ───────────────────────────────────────────────────────────────
console.log("\n2. Settlement holds");
const lossHold = await holdRow(loss.holdId);
check(
  lossHold?.status === "open" && lossHold.reason === "dispute" && lossHold.parcelId === pLoss.id && lossHold.amountCents === 500_000,
  "the loss claim raised an open parcel hold for the claimed amount",
  `${lossHold?.id} ${lossHold?.status} ${lossHold?.amountCents}c`,
);
const shortHold = await holdRow(short.holdId);
check(shortHold?.status === "open" && shortHold.disputeId === short.id, "the COD shortfall raised its own hold", String(shortHold?.id));
const billing = await m("billing").disputes.open({
  type: "billing",
  claimAmountCents: 15_000,
  description: `${RUN} fuel surcharge billed twice on last invoice`,
});
check(billing.holdId === null && billing.parcelId === null, "a billing dispute holds no payout", billing.code);
r = await refusal(m("billing-zero").disputes.open({ type: "billing", claimAmountCents: 0, description: `${RUN} billing with no amount` }));
check(r.status === 400, "a billing dispute must name an amount", r.detail);

// ── 3. one live case per parcel and type ────────────────────────────────────
console.log("\n3. Duplicates");
r = await refusal(
  m("loss-dup").disputes.open({ awb: pLoss.awb, type: "loss", claimAmountCents: 1000, description: `${RUN} second loss claim, same parcel` }),
);
check(r.status === 409, "a second live loss claim on the same parcel is refused", r.detail);
const lossKey = key("loss-replay");
const replayA = await clientFor(merchant.accessToken, lossKey).disputes.open({
  awb: pDmg.awb,
  type: "damage",
  claimAmountCents: 120_000,
  description: `${RUN} box crushed, contents broken`,
});
const replayB = await clientFor(merchant.accessToken, lossKey).disputes.open({
  awb: pDmg.awb,
  type: "damage",
  claimAmountCents: 120_000,
  description: `${RUN} box crushed, contents broken`,
});
const dmgRows = await db
  .select()
  .from(cod.codDispute)
  .where(and(eq(cod.codDispute.parcelId, pDmg.id), eq(cod.codDispute.type, "damage")));
check(replayA.id === replayB.id && dmgRows.length === 1, "the same Idempotency-Key replays the first case, nothing more", `${dmgRows.length} row(s)`);
const dmg = replayA;

// ── 4. §5 scoping ──────────────────────────────────────────────────────────
console.log("\n4. Merchant scoping (§5)");
r = await refusal(
  m("other-mch").disputes.open({ merchantId: OTHER, type: "sla", claimAmountCents: 0, description: `${RUN} naming another merchant` }),
);
check(r.status === 403, "a merchant naming another merchant is 403", r.detail);
r = await refusal(
  m("other-awb").disputes.open({ awb: pOther.awb, type: "damage", claimAmountCents: 1000, description: `${RUN} another merchant's AWB` }),
);
check(r.status === 404, "a merchant naming another merchant's AWB is 404", r.detail);
const otherCase = await f("other-case").disputes.open({
  merchantId: OTHER,
  awb: pOther.awb,
  type: "damage",
  claimAmountCents: 50_000,
  description: `${RUN} raised by finance for Lanka Gadgets`,
});
r = await refusal(mr.disputes.get({ disputeId: otherCase.id }));
check(r.status === 404, "another merchant's case by id is 404", r.detail);
r = await refusal(m("other-withdraw").disputes.withdraw({ disputeId: otherCase.id, reason: "not mine" }));
check(r.status === 404, "withdrawing another merchant's case is 404", r.detail);
r = await refusal(mr.disputes.list({ merchantId: OTHER }));
check(r.status === 403, "listing another merchant's cases is 403", r.detail);
const mine = await mr.disputes.list({ limit: 200 });
check(mine.rows.length > 0 && mine.rows.every((d) => d.merchantId === MERCHANT), "an unfiltered merchant list holds only its own cases", `${mine.total} total`);
r = await refusal(m("m-assign").disputes.assign({ disputeId: loss.id }));
check(r.status === 403, "a merchant cannot assign", String(r.status));
r = await refusal(m("m-resolve").disputes.resolve({ disputeId: loss.id, outcome: "upheld", resolution: "I decide my own claim", approvedAmountCents: 1, remedy: "bank_transfer", payoutRef: "UTR123456" }));
check(r.status === 403, "a merchant cannot decide", String(r.status));
r = await refusal(clientFor(ops.accessToken, key("ops-resolve")).disputes.resolve({ disputeId: loss.id, outcome: "rejected", resolution: "ops should not decide this" }));
check(r.status === 403, "ops cannot decide (finance only)", String(r.status));
r = await refusal(clientFor(rider.accessToken).disputes.list({}));
check(r.status === 403, "a rider cannot read the dispute queue", String(r.status));
r = await refusal(clientFor(merchant.accessToken).disputes.open({ type: "sla", claimAmountCents: 0, description: `${RUN} no idempotency key` }));
check(r.status === 400 || r.status === 428, "opening without an Idempotency-Key is refused", `${r.status} ${r.type}`);

// ── 5. maker–checker ───────────────────────────────────────────────────────
console.log("\n5. Maker–checker");
r = await refusal(f("self-resolve").disputes.resolve({ disputeId: otherCase.id, outcome: "rejected", resolution: "opener tries to close it" }));
check(r.status === 403 && r.type === "maker-checker", "the finance user who opened a case cannot decide it", `${r.status} ${r.type}`);
const assigned = await f("assign").disputes.assign({ disputeId: loss.id });
check(assigned.status === "investigating" && assigned.assignedToId === finance.user.id, "finance picks up the loss claim", String(assigned.assignedToName));

// ── 6. remedies and hold release ────────────────────────────────────────────
console.log("\n6. Remedies");
r = await refusal(f("over-approve").disputes.resolve({ disputeId: loss.id, outcome: "upheld", approvedAmountCents: 500_001, resolution: "approving too much money", remedy: "bank_transfer", payoutRef: "UTR000001" }));
check(r.status === 400 && r.type === "approval-exceeds-claim", "approving more than was claimed is refused", `${r.status} ${r.type}`);
r = await refusal(f("no-remedy").disputes.resolve({ disputeId: loss.id, outcome: "upheld", approvedAmountCents: 400_000, resolution: "upheld but no remedy named" }));
check(r.status === 400, "upheld money must say how it is paid", r.detail);
r = await refusal(f("short-utr").disputes.resolve({ disputeId: loss.id, outcome: "upheld", approvedAmountCents: 400_000, resolution: "upheld with a short UTR", remedy: "bank_transfer", payoutRef: "U1" }));
check(r.status === 400, "a bank transfer needs a real UTR", r.detail);
const lossDone = await f("loss-resolve").disputes.resolve({
  disputeId: loss.id,
  outcome: "upheld",
  approvedAmountCents: 400_000,
  resolution: "Lost at the Kandy hub; paid 80% of declared per goodwill",
  remedy: "bank_transfer",
  payoutRef: `UTR${RUN}01`,
});
check(
  lossDone.status === "resolved" && lossDone.approvedAmountCents === 400_000 && lossDone.remedy === "bank_transfer" && lossDone.payoutRef === `UTR${RUN}01`,
  "the loss claim is upheld and paid by bank transfer, UTR recorded",
  `${lossDone.code} ${lossDone.approvedAmountCents}c ${lossDone.payoutRef}`,
);
check(lossDone.resolvedById === finance.user.id && Boolean(lossDone.resolvedAt), "the decider is named", String(lossDone.resolvedByName));
check((await holdRow(loss.holdId))?.status === "cleared", "its hold is released", String((await holdRow(loss.holdId))?.status));
r = await refusal(f("loss-again").disputes.resolve({ disputeId: loss.id, outcome: "rejected", resolution: "deciding a closed case again" }));
check(r.status === 409, "a decided case cannot be decided again", r.detail);

// credit note: needs an issued invoice of the same merchant with room on it.
// Filter for room in SQL: each run credits Rs. 150, so the first issued invoice
// eventually fills up, and falling back to "invoice the current period" then
// collides with that same invoice (409 invoice-exists).
const [invoice] = await db
  .select()
  .from(cod.codInvoice)
  .where(and(
    eq(cod.codInvoice.merchantId, MERCHANT),
    inArray(cod.codInvoice.status, ["issued", "part_paid", "paid", "overdue"]),
    sql`${cod.codInvoice.totalCents} - ${cod.codInvoice.creditedCents} >= 15000`,
  ))
  .limit(1);
let invoiceId = invoice?.id ?? null;
if (!invoiceId) {
  // No room anywhere: invoice the most recent period that has no invoice yet.
  for (let weeksBack = 0; weeksBack < 104 && !invoiceId; weeksBack++) {
    const asOf = new Date(Date.now() - weeksBack * 7 * 86_400_000).toISOString().slice(0, 10);
    try {
      const created = await f(`inv-create-${weeksBack}`).finance.createInvoice({
        merchantId: MERCHANT,
        asOf,
        charges: [{ description: `Delivery charges — ${RUN}`, unitCents: 50_000, quantity: 2 }],
      });
      invoiceId = (await f("inv-issue").finance.issueInvoice({ invoiceId: created.invoice.id })).id;
    } catch (e) {
      if ((e as { data?: { type?: string } }).data?.type?.endsWith("/invoice-exists")) continue;
      throw e;
    }
  }
  if (!invoiceId) throw new Error("no un-invoiced period in the last two years");
}
const before = (await db.select().from(cod.codInvoice).where(eq(cod.codInvoice.id, invoiceId)))[0]!;
check(before.status !== "draft" && before.status !== "void", "an issued Ceylon Threads invoice is available", `${before.code} ${before.status}`);

const [otherInvoice] = await db
  .select()
  .from(cod.codInvoice)
  .where(and(ne(cod.codInvoice.merchantId, MERCHANT), ne(cod.codInvoice.status, "draft")));
if (otherInvoice) {
  r = await refusal(f("cn-wrong").disputes.resolve({ disputeId: billing.id, outcome: "upheld", approvedAmountCents: 15_000, resolution: "credit against wrong merchant", remedy: "credit_note", invoiceId: otherInvoice.id }));
  check(r.status === 400, "a credit note against another merchant's invoice is refused", r.detail);
}
const billDone = await f("cn").disputes.resolve({
  disputeId: billing.id,
  outcome: "upheld",
  approvedAmountCents: 15_000,
  resolution: "Surcharge was billed twice; credit raised",
  remedy: "credit_note",
  invoiceId,
});
const after = (await db.select().from(cod.codInvoice).where(eq(cod.codInvoice.id, invoiceId)))[0]!;
const [cn] = billDone.creditNoteId
  ? await db.select().from(cod.codCreditNote).where(eq(cod.codCreditNote.id, billDone.creditNoteId))
  : [];
check(billDone.status === "resolved" && billDone.remedy === "credit_note" && Boolean(cn), "the billing dispute is upheld by credit note", String(cn?.code));
check(cn?.amountCents === 15_000 && cn.disputeId === billing.id && cn.invoiceId === invoiceId, "the credit note is for the approved amount and points back at the case", `${cn?.amountCents}c`);
check(after.creditedCents - before.creditedCents === 15_000, "the invoice's credited total moved by exactly that", `${before.creditedCents} → ${after.creditedCents}`);

const shortRejected = await f("short-reject").disputes.resolve({
  disputeId: short.id,
  outcome: "rejected",
  resolution: "Rider remitted in full; POD and deposit slip match",
});
check(shortRejected.status === "rejected" && shortRejected.approvedAmountCents === 0, "the shortfall is rejected and pays nothing", shortRejected.code);
check((await holdRow(short.holdId))?.status === "cleared", "a rejected case releases its hold too", "");

const withdrawn = await m("withdraw").disputes.withdraw({ disputeId: dmg.id, reason: "consignee found the item intact" });
check(withdrawn.status === "withdrawn" && (await holdRow(dmg.holdId))?.status === "cleared", "a merchant withdraws its damage claim; the hold is released", withdrawn.code);
const reopen = await m("dmg-reopen").disputes.open({ awb: pDmg.awb, type: "damage", claimAmountCents: 10_000, description: `${RUN} reopened after a second look` });
check(reopen.status === "open", "with no live case left, a fresh one may be opened on the parcel", reopen.code);
await a("otherc-close").disputes.resolve({ disputeId: otherCase.id, outcome: "rejected", resolution: "probe fixture closed by admin" });
await m("reopen-close").disputes.withdraw({ disputeId: reopen.id, reason: `probe ${RUN} cleanup` });

// ── 7. outbox → finance alert ───────────────────────────────────────────────
console.log("\n7. Outbox → finance alert");
let alert: Awaited<ReturnType<AppRouterClient["cod"]["listAlerts"]>>[number] | undefined;
for (let i = 0; i < 20 && !alert; i++) {
  const list = await clientFor(finance.accessToken).cod.listAlerts({ kind: "dispute_opened", limit: 200 });
  alert = list.find((x) => x.disputeId === loss.id);
  if (!alert) await new Promise((res) => setTimeout(res, 1500));
}
check(Boolean(alert), "the worker raised a dispute_opened alert", alert?.summary ?? "none within 30s");
check(alert?.audience === "finance" && Boolean(alert?.summary.includes(loss.code)), "it is for finance and names the case code", String(alert?.summary));
// The case is closed by now, so its doorbell alert must be too — whether the
// worker raised it before the decision (closed with the case) or after it
// (closed as soon as it was raised). reopen was withdrawn within a second.
const closedCases = [loss, dmg, reopen];
let caseAlerts: { disputeId: string | null; status: string }[] = [];
for (let i = 0; i < 20; i++) {
  caseAlerts = await db
    .select({ disputeId: cod.codOpsAlert.disputeId, status: cod.codOpsAlert.status })
    .from(cod.codOpsAlert)
    .where(inArray(cod.codOpsAlert.disputeId, closedCases.map((c) => c.id)));
  // Wait for the settled state, not just for the rows to exist: an alert raised
  // after its case closed is inserted open and closed by the worker one DB
  // round trip later, and a read in that gap is not a failure.
  if (closedCases.every((c) => caseAlerts.some((x) => x.disputeId === c.id)) && caseAlerts.every((x) => x.status === "resolved")) break;
  await new Promise((res) => setTimeout(res, 1500));
}
check(
  closedCases.every((c) => caseAlerts.some((x) => x.disputeId === c.id)) && caseAlerts.every((x) => x.status === "resolved"),
  "closed cases leave no live dispute_opened alert (decided, withdrawn, and withdrawn before the worker ran)",
  caseAlerts.map((x) => x.status).join(","),
);

// ── 8. register and counts ─────────────────────────────────────────────────
console.log("\n8. Register and counts");
const reg = await fr.disputes.list({ register: true, limit: 200 });
check(reg.rows.every((d) => d.type === "loss" || d.type === "damage"), "the register holds only loss and damage claims", `${reg.total} claims`);
check(reg.rows.some((d) => d.id === loss.id) && !reg.rows.some((d) => d.id === billing.id), "the loss claim is in it, the billing dispute is not", "");
const byCode = await fr.disputes.list({ q: loss.code });
check(byCode.total === 1 && byCode.rows[0]?.id === loss.id, "search by case code", loss.code);
const page = await fr.disputes.list({ limit: 2, offset: 0 });
check(page.rows.length <= 2 && page.total >= 6, "lists paginate server-side with a total", `${page.rows.length} of ${page.total}`);
const counts = await mr.disputes.counts({});
check(counts.register.paidBankCents >= 400_000, "merchant counts include the bank-paid claim", JSON.stringify(counts.register));
const meta = await mr.disputes.meta({});
check(meta.types.filter((t) => t.isClaim).map((t) => t.type).sort().join() === "damage,loss", "meta marks loss and damage as claims", "");

console.log(`\n${"─".repeat(70)}`);
if (failures.length) {
  console.log(`disputes probe: ${pass} passed, ${failures.length} FAILED`);
  for (const x of failures) console.log(`  - ${x}`);
  process.exit(1);
}
console.log(`disputes probe: ${pass}/${pass} checks passed (${RUN})`);
process.exit(0);
