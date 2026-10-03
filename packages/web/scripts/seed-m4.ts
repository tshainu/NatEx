/**
 * M4 demo seed — PROJECT.md §10 M4 / §12 "demonstrable with real data".
 *
 * Builds one labelled demo merchant, "Serendib Spice Co. (M4 demo)", and walks
 * its money through every finance state the portal shows, over the real API
 * (so idempotency keys, maker–checker and the audit log are all exercised the
 * way a person would):
 *
 *   COD          6 doorstep collections by the Colombo rider
 *   deposits     one declared, counted and banked; one declared and waiting
 *                for finance to count it (a live queue item)
 *   settlement   drafted with a penalty, proposed by finance, approved by
 *                admin (the checker), payout file exported, paid with a UTR
 *   invoice      drafted, issued, part paid; a goodwill credit note
 *   disputes     a billing dispute upheld as a credit note against that
 *                invoice, a packaging charge rejected, an SLA claim left open
 *
 * IDEMPOTENT. Every run wipes the demo merchant's own money and dispute rows
 * (scripts/lib/money-fixture.ts) and rebuilds them, so running it twice leaves
 * one copy. It touches no seeded or probe merchant's money.
 *
 * It also closes the dispute_opened alerts left live by cases that were closed
 * before alerts.ts learnt to close them with the case (a one-off backfill;
 * harmless on a tidy database).
 *
 * Needs the dev server (it goes through the API) and the base seed:
 *
 *   bun run db:seed              # once, destructive base data
 *   bun --env-file=../../.env scripts/seed-m4.ts
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { and, eq, inArray, like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";
import { resetMerchantMoney } from "./lib/money-fixture";

if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo money with NODE_ENV=production.");

const BASE = process.env.SEED_API ?? "http://localhost:4200";
const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { merchant: merchantTable } = await import("../src/api/database/schema/merchants");
const cod = await import("../src/api/database/schema/cod");
const { recordCollection } = await import("../src/api/modules/cod/service");
const { closeDisputeAlerts } = await import("../src/api/modules/cod/alerts");
const { seedFinanceConfig } = await import("../src/api/modules/cod/config");
const { addDays, colomboToday } = await import("../src/api/shared/time");

const MCH = "mch_m4_demo";
const MCH_NAME = "Serendib Spice Co. (M4 demo)";
const BRANCH = "brn_cmb_central";
const SRC = "m4demo";
const LABEL = "M4 demo";
const RUN = Date.now().toString(36).toUpperCase().slice(-6);

let keySeq = 0;
const key = (label: string) => `seed-m4-${RUN}-${label}-${++keySeq}`;
function clientFor(token?: string, idemKey?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${BASE}/api/rpc`,
      headers: () => ({
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idemKey ? { "idempotency-key": idemKey } : {}),
      }),
    }),
  );
}
const anon = clientFor();
type Session = Awaited<ReturnType<typeof anon.identity.verifyOtp>>;
async function login(phone: string): Promise<Session> {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.%Otp"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone} — is this the dev server?`);
  return finishMfa(BASE, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: "seed-m4" }));
}
const say = (what: string, detail: string) => console.log(`  ${what.padEnd(12)} ${detail}`);
const lkr = (cents: number) => `Rs. ${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

console.log(`\nM4 demo seed → ${BASE} (${RUN})`);

// ── 0. the demo merchant, wiped back to nothing ──────────────────────────────
await seedFinanceConfig();
await db
  .insert(merchantTable)
  .values({
    id: MCH,
    branchId: BRANCH,
    name: MCH_NAME,
    address: "27 Spice Mill Road, Colombo 10",
    contactName: "Anoma Wickramasinghe",
    contactPhone: "+94700004444",
  })
  .onConflictDoNothing();
const priorDisputes = await db.select({ id: cod.codDispute.id }).from(cod.codDispute).where(eq(cod.codDispute.merchantId, MCH));
if (priorDisputes.length) {
  const ids = priorDisputes.map((d) => d.id);
  await db.delete(cod.codOpsAlert).where(inArray(cod.codOpsAlert.disputeId, ids));
  await db.delete(cod.codDispute).where(inArray(cod.codDispute.id, ids));
}
const reset = await resetMerchantMoney(MCH, SRC);
say("reset", `${MCH}: money and ${priorDisputes.length} dispute(s) wiped${reset.sharedDeposits.length ? `; shared deposits kept: ${reset.sharedDeposits.join(", ")}` : ""}`);

const rider = await login("+94771234567");
const finance = await login("+94774567890"); // maker
const admin = await login("+94773456789"); // checker
const f = (label: string) => clientFor(finance.accessToken, key(label));
const a = (label: string) => clientFor(admin.accessToken, key(label));
const fr = clientFor(finance.accessToken);

// ── 1. COD on the doorstep ───────────────────────────────────────────────────
// The doorstep half (POD, OTP) is M3's and is seeded by the base seed's parcels;
// here the ledger posting is made the way the delivery module makes it.
async function collect(amounts: number[], batch: string): Promise<{ ids: string[]; cents: number }> {
  const ids: string[] = [];
  for (const [i, amountCents] of amounts.entries()) {
    const r = await recordCollection({
      parcelId: `${SRC}-${batch}-${i + 1}`,
      awb: `SSC${batch.toUpperCase()}${String(i + 1).padStart(3, "0")}`,
      merchantId: MCH,
      riderId: rider.user.id,
      branchId: BRANCH,
      amountCents,
      mode: "cash",
      clientId: `${SRC}-${RUN}-${batch}-${i + 1}`,
      actor: { userId: rider.user.id, name: rider.user.name, role: "rider", branchId: BRANCH },
    });
    ids.push(r.entry.id);
  }
  return { ids, cents: amounts.reduce((s, x) => s + x, 0) };
}
const banked = await collect([485_000, 312_550, 129_900, 264_000], "a");
const waiting = await collect([158_000, 99_500], "b");
say("collected", `6 parcels, ${lkr(banked.cents + waiting.cents)} by ${rider.user.name}`);

// ── 2. deposits: one through to the bank, one waiting to be counted ─────────
const dep1 = await clientFor(rider.accessToken, key("declare-a")).cod.declareDeposit({
  branchId: BRANCH,
  declaredCents: banked.cents,
  entryIds: banked.ids,
  note: `${LABEL}: Monday's cash`,
});
await f("verify-a").cod.verifyDeposit({ depositId: dep1.id, countedCents: banked.cents });
await f("bank-a").cod.bankDeposit({ depositId: dep1.id, bankRef: `SSC-SLIP-${RUN}`, bankAccount: "0012345678" });
const dep2 = await clientFor(rider.accessToken, key("declare-b")).cod.declareDeposit({
  branchId: BRANCH,
  declaredCents: waiting.cents,
  entryIds: waiting.ids,
  note: `${LABEL}: Tuesday's cash, not yet counted`,
});
say("deposits", `${dep1.code} banked ${lkr(banked.cents)} · ${dep2.code} declared ${lkr(waiting.cents)}, waiting for finance`);

// ── 3. the weekly settlement, maker → checker → bank → UTR ──────────────────
const period = await fr.finance.currentPeriod({});
// Collections banked today fall in the period that ends at the NEXT cut-off.
const today = colomboToday();
const asOf = period.periodEnd === today ? today : addDays(period.periodEnd, 7);
await f("payout").finance.setPayoutDetails({
  merchantId: MCH,
  beneficiaryName: "Serendib Spice Co. (Pvt) Ltd",
  bankName: "Hatton National Bank",
  branchName: "Maradana",
  accountNumber: "0410 2233 4455",
  verified: true,
});
const created = await f("stl-create").finance.createSettlement({
  merchantId: MCH,
  asOf,
  deductions: [{ type: "penalty", amountCents: 15_000, description: `${LABEL}: late pickup, 2 parcels` }],
});
const stlId = created.settlement.id;
await f("stl-propose").finance.proposeSettlement({ settlementId: stlId });
await a("stl-approve").finance.approveSettlement({ settlementId: stlId });
const file = await f("stl-csv").finance.exportPayoutCsv({ settlementIds: [stlId] });
const paid = await a("stl-paid").finance.recordPayout({ settlementId: stlId, utr: `HNB${RUN}7781` });
say("settlement", `${paid.settlement.code} paid ${lkr(paid.settlement.netCents)} (gross ${lkr(paid.settlement.grossCents)} − ${lkr(paid.settlement.deductionsCents)}), file ${file.rows.length} row, UTR ${paid.settlement.utr}`);

// ── 4. the period invoice ───────────────────────────────────────────────────
const inv = await f("inv-create").finance.createInvoice({
  merchantId: MCH,
  asOf,
  charges: [
    { description: `${LABEL}: delivery charges, Colombo zone`, unitCents: 35_000, quantity: 6 },
    { description: `${LABEL}: COD handling fee`, unitCents: 7_500, quantity: 6 },
    { description: `${LABEL}: packaging — spice tins`, unitCents: 12_000, quantity: 4 },
  ],
});
const invId = inv.invoice.id;
const issued = await f("inv-issue").finance.issueInvoice({ invoiceId: invId, asOf });
const outstanding = issued.totalCents - issued.paidCents - issued.creditedCents - issued.recoveredCents;
const partial = Math.max(100, Math.floor(outstanding / 2 / 100) * 100);
await f("inv-pay").finance.recordInvoicePayment({ invoiceId: invId, amountCents: partial, reference: `SSC-RCPT-${RUN}` });
say("invoice", `${issued.code} ${lkr(issued.totalCents)}, ${lkr(issued.recoveredCents)} recovered from COD, ${lkr(partial)} paid by bank`);

// ── 5. disputes: upheld (credit note), rejected, open ───────────────────────
// Opened by admin on the merchant's behalf (as from a phone call), so finance —
// not the opener — may decide them.
const billing = await a("dsp-billing").disputes.open({
  merchantId: MCH,
  type: "billing",
  claimAmountCents: 35_000,
  description: `${LABEL}: one parcel was charged twice for delivery on the same day.`,
});
await f("dsp-billing-pick").disputes.assign({ disputeId: billing.id });
const upheld = await f("dsp-billing-uphold").disputes.resolve({
  disputeId: billing.id,
  outcome: "upheld",
  approvedAmountCents: 35_000,
  remedy: "credit_note",
  invoiceId: invId,
  resolution: "Duplicate delivery line confirmed against the runsheet; credited in full.",
});
// A COD shortfall needs a real parcel (and raises a hold); the demo merchant's
// collections are ledger-only, so the rejected case is a billing query instead.
const weight = await a("dsp-weight").disputes.open({
  merchantId: MCH,
  type: "billing",
  claimAmountCents: 48_000,
  description: `${LABEL}: the packaging line for spice tins should not have been charged.`,
});
await f("dsp-weight-pick").disputes.assign({ disputeId: weight.id });
const rejected = await f("dsp-weight-reject").disputes.resolve({
  disputeId: weight.id,
  outcome: "rejected",
  resolution: "Tins were packed by NatEx at the merchant's request on the pickup note; the charge stands.",
});
const sla = await a("dsp-sla").disputes.open({
  merchantId: MCH,
  type: "sla",
  claimAmountCents: 30_000,
  description: `${LABEL}: two next-day parcels to Kandy took three days.`,
});
say("disputes", `${upheld.code} upheld (credit note ${lkr(upheld.approvedAmountCents ?? 0)}) · ${rejected.code} rejected · ${sla.code} open`);

// ── 6. backfill: live alerts on closed cases ────────────────────────────────
const liveDisputeAlerts = await db
  .select({ disputeId: cod.codOpsAlert.disputeId })
  .from(cod.codOpsAlert)
  .where(and(eq(cod.codOpsAlert.kind, "dispute_opened"), inArray(cod.codOpsAlert.status, ["open", "acknowledged"])));
const caseIds = [...new Set(liveDisputeAlerts.map((x) => x.disputeId).filter((x): x is string => Boolean(x)))];
let closedAlerts = 0;
if (caseIds.length) {
  const cases = await db
    .select({ id: cod.codDispute.id, code: cod.codDispute.code, status: cod.codDispute.status })
    .from(cod.codDispute)
    .where(inArray(cod.codDispute.id, caseIds));
  for (const c of cases.filter((x) => x.status !== "open" && x.status !== "investigating")) {
    closedAlerts += await closeDisputeAlerts(c.id, `${c.code} was already ${c.status}; closed by the M4 seed backfill.`, null);
  }
}
say("backfill", `${closedAlerts} stale dispute alert(s) closed`);

// ── summary ─────────────────────────────────────────────────────────────────
const [stl] = await db.select().from(cod.codSettlement).where(eq(cod.codSettlement.id, stlId));
const [invRow] = await db.select().from(cod.codInvoice).where(eq(cod.codInvoice.id, invId));
const disputes = await db.select({ code: cod.codDispute.code, status: cod.codDispute.status }).from(cod.codDispute).where(eq(cod.codDispute.merchantId, MCH));
console.log("\nSeeded (M4 demo):", JSON.stringify(
  {
    merchant: `${MCH} — ${MCH_NAME}`,
    deposits: { banked: dep1.code, waitingToBeCounted: dep2.code },
    settlement: { code: stl?.code, status: stl?.status, netCents: stl?.netCents, utr: stl?.utr },
    invoice: { code: invRow?.code, status: invRow?.status, totalCents: invRow?.totalCents, paidCents: invRow?.paidCents, creditedCents: invRow?.creditedCents, recoveredCents: invRow?.recoveredCents },
    disputes,
    see: ["/finance", "/finance/remittances", "/finance/invoices", "/finance/disputes", "/finance/cod?tab=deposits"],
  },
  null,
  2,
));
process.exit(0);
