/**
 * Probe: a merchant never sees finance's working state (§8 maker–checker,
 * §5 scoping). Drafts, proposals, rejected runs, a run held before approval and
 * draft/void invoices must be invisible through every merchant read — list,
 * page, by-id, statement and AR — while finance still sees all of them.
 *
 * Fixtures are inserted directly with periods in 2020 (so they cannot collide
 * with any live run's one-open-run-per-period slot) and deleted in `finally`.
 *
 *   bun --env-file=../../.env scripts/probe-merchant-visibility.ts
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

const BASE = "http://localhost:4200";
const MCH = "mch_ceylon_threads";
const { db } = await import("../src/api/database");
const { cleanupWithRetry, hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { codSettlement, codInvoice } = await import("../src/api/database/schema/cod");

let pass = 0;
const fails: string[] = [];
const check = (c: boolean, l: string, d = "") => {
  if (c) { pass++; console.log("  PASS", l, d); } else { fails.push(l); console.log("  FAIL", l, d); }
};
const clientFor = (token?: string): AppRouterClient =>
  createORPCClient(new RPCLink({ url: `${BASE}/api/rpc`, headers: () => (token ? { authorization: `Bearer ${token}` } : {}) }));
const anon = clientFor();
async function login(phone: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.%Otp"));
  const c = await anon.identity.requestOtp({ phone });
  return finishMfa(BASE, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode!, deviceId: null }));
}
const status = async (fn: () => Promise<unknown>) => {
  try { await fn(); return 200; } catch (e) { return (e as { data?: { status?: number } }).data?.status ?? -1; }
};

const fin = clientFor((await login("+94774567890")).accessToken);
const mer = clientFor((await login("+94775678901")).accessToken);

const tag = Date.now().toString(36).toUpperCase();
const base = {
  merchantId: MCH,
  merchantName: "Ceylon Threads (probe)",
  grossCents: 123_45,
  deductionsCents: 0,
  netCents: 123_45,
  createdById: "probe",
  createdByName: "Probe",
};
// One hidden run per working state, plus a held-after-approval run that IS visible.
const runs = [
  { ...base, id: `stl_pv_d_${tag}`, code: `PV-D-${tag}`, status: "draft", periodStart: "2020-01-04", periodEnd: "2020-01-10", payoutDate: "2020-01-15" },
  { ...base, id: `stl_pv_p_${tag}`, code: `PV-P-${tag}`, status: "proposed", periodStart: "2020-01-11", periodEnd: "2020-01-17", payoutDate: "2020-01-22", proposedAt: new Date() },
  { ...base, id: `stl_pv_r_${tag}`, code: `PV-R-${tag}`, status: "rejected", periodStart: "2020-01-18", periodEnd: "2020-01-24", payoutDate: "2020-01-29", rejectedReason: "probe" },
  { ...base, id: `stl_pv_h_${tag}`, code: `PV-H-${tag}`, status: "on_hold", periodStart: "2020-01-25", periodEnd: "2020-01-31", payoutDate: "2020-02-05", holdReason: "probe: unapproved" },
  { ...base, id: `stl_pv_ha_${tag}`, code: `PV-HA-${tag}`, status: "on_hold", periodStart: "2020-02-01", periodEnd: "2020-02-07", payoutDate: "2020-02-12", holdReason: "probe: approved then held", approvedById: "probe-checker", approvedByName: "Checker", approvedAt: new Date() },
];
const HIDDEN_RUNS = runs.slice(0, 4).map((r) => r.id);
const HELD_APPROVED = runs[4]!.id;
const invBase = { merchantId: MCH, merchantName: "Ceylon Threads (probe)", subtotalCents: 500_00, totalCents: 500_00 };
const invoices = [
  { ...invBase, id: `inv_pv_d_${tag}`, code: `PVI-D-${tag}`, status: "draft", periodStart: "2020-01-01", periodEnd: "2020-01-31", dueDate: "2020-02-15" },
  { ...invBase, id: `inv_pv_v_${tag}`, code: `PVI-V-${tag}`, status: "void", periodStart: "2020-02-01", periodEnd: "2020-02-29", dueDate: "2020-03-15" },
];
const HIDDEN_INV = invoices.map((i) => i.id);

await db.delete(codSettlement).where(like(codSettlement.id, "stl_pv_%"));
await db.delete(codInvoice).where(like(codInvoice.id, "inv_pv_%"));
try {
  await db.insert(codSettlement).values(runs);
  await db.insert(codInvoice).values(invoices);

  // Finance sees every one of them — the fixtures are real.
  const fAll = await fin.finance.settlementPage({ merchantId: MCH, q: `-${tag}`, pageSize: 50 });
  check(fAll.total === 5, "finance sees all 5 probe runs", `${fAll.total}`);
  const fInv = await fin.finance.invoicePage({ merchantId: MCH, q: `-${tag}`, pageSize: 50 });
  check(fInv.total === 2, "finance sees both probe invoices", `${fInv.total}`);
  check((await status(() => fin.finance.settlementById({ settlementId: HIDDEN_RUNS[0]! }))) === 200, "finance reads a draft by id");

  // Merchant: page, with and without asking for the hidden statuses.
  const mPage = await mer.finance.settlementPage({ q: `-${tag}`, pageSize: 50 });
  check(mPage.total === 1 && mPage.rows[0]?.id === HELD_APPROVED, "merchant page shows only the approved-then-held run", `${mPage.total}`);
  const mAsk = await mer.finance.settlementPage({ status: ["draft", "proposed", "rejected"], pageSize: 50 });
  check(mAsk.total === 0 && mAsk.rows.length === 0, "merchant asking for draft/proposed/rejected gets nothing", `${mAsk.total}`);
  const mAll = await mer.finance.settlementPage({ pageSize: 200 });
  check(mAll.rows.every((r) => ["approved", "paid", "on_hold"].includes(r.status)), "every merchant page row is approved/paid/held", `${mAll.total}`);
  check(mAll.rows.every((r) => r.status !== "on_hold" || r.approvedAt !== null), "every held run a merchant sees was approved first");
  const mList = await mer.finance.settlements({ limit: 200 });
  check(!mList.some((r) => HIDDEN_RUNS.includes(r.id)), "merchant array route hides working runs", `${mList.length}`);

  // By id: hidden → 404 (not 403: it is theirs, it just is not a payout yet).
  for (const id of HIDDEN_RUNS) {
    check((await status(() => mer.finance.settlementById({ settlementId: id }))) === 404, `merchant by-id ${id.split("_")[2]} → 404`);
  }
  check((await status(() => mer.finance.settlementById({ settlementId: HELD_APPROVED }))) === 200, "merchant reads approved-then-held run by id");

  // Statement.
  const st = await mer.finance.statement({});
  check(!st.settlements.some((r) => HIDDEN_RUNS.includes(r.id)), "statement.settlements hides working runs", `${st.settlements.length}`);
  check(st.settlements.every((r) => ["approved", "paid", "on_hold"].includes(r.status)), "statement.settlements all merchant-visible");
  const fst = await fin.finance.statement({ merchantId: MCH });
  check(fst.settlements.some((r) => HIDDEN_RUNS.includes(r.id)), "finance statement still shows working runs");

  // Invoices.
  const miPage = await mer.finance.invoicePage({ q: `-${tag}`, pageSize: 50 });
  check(miPage.total === 0, "merchant invoice page hides draft + void", `${miPage.total}`);
  const miAsk = await mer.finance.invoicePage({ status: ["draft", "void"], pageSize: 50 });
  check(miAsk.total === 0, "merchant asking for draft/void invoices gets nothing", `${miAsk.total}`);
  const miAll = await mer.finance.invoicePage({ pageSize: 200 });
  check(miAll.rows.every((r) => ["issued", "part_paid", "paid"].includes(r.status)), "every merchant invoice row is issued onwards", `${miAll.total}`);
  const miList = await mer.finance.invoices({ limit: 200 });
  check(!miList.some((r) => HIDDEN_INV.includes(r.id)), "merchant invoice array route hides draft + void");
  for (const id of HIDDEN_INV) {
    check((await status(() => mer.finance.invoiceById({ invoiceId: id }))) === 404, `merchant invoice by-id ${id.split("_")[2]} → 404`);
  }
  check((await status(() => fin.finance.invoiceById({ invoiceId: HIDDEN_INV[0]! }))) === 200, "finance reads a draft invoice by id");

  // AR.
  const ar = await mer.finance.merchantAr({});
  check(!ar.invoices.some((r) => HIDDEN_INV.includes(r.id)), "merchantAr hides draft + void", `${ar.invoices.length}`);
  const far = await fin.finance.merchantAr({ merchantId: MCH });
  check(far.invoices.some((r) => r.id === HIDDEN_INV[0]), "finance merchantAr still shows the draft");
} finally {
  // Sweep by prefix so a run that died mid-way is cleaned up by the next one.
  // Retried: Turso resets idle sockets, and a fixture left behind is a lie in the books.
  await cleanupWithRetry(async () => {
    await db.delete(codSettlement).where(like(codSettlement.id, "stl_pv_%"));
    await db.delete(codInvoice).where(like(codInvoice.id, "inv_pv_%"));
  });
  console.log("  (fixtures removed)");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
process.exit(0);
