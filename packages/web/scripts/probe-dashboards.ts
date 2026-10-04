import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

/**
 * Round 6 dashboards against a running dev server.
 *
 *   parcels.trends   — every day filled, §5 scope (merchant / branch / network),
 *                      every figure re-derived here from the raw rows
 *   cod.dailyFlow    — desk roles only; window totals equal the ledger's own
 *                      live entries for the same window
 *   dashboard.company — admin only; its parts equal parcels.summary and
 *                      cod.reconciliation read separately
 *
 * Read-only: creates no fixtures. Requires a server on :4200 and a seeded DB.
 *
 *   bun --env-file=../../.env scripts/probe-dashboards.ts
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4200";
const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { parcel, parcelEvent } = await import("../src/api/database/schema/parcels");
const { codEntry } = await import("../src/api/database/schema/cod");
const { liveEntries } = await import("../src/api/modules/cod/accounts");

let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) pass += 1;
  else failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
async function expectStatus(label: string, status: number, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(false, label, "expected a rejection, got success");
  } catch (err) {
    const got = (err as { data?: { status?: number } })?.data?.status;
    check(got === status, label, `status ${got}`);
  }
}

function clientFor(token?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({ url: `${BASE}/api/rpc`, headers: () => (token ? { authorization: `Bearer ${token}` } : {}) }),
  );
}
const anon = clientFor();
async function login(phone: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.%Otp"));
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%mfa.%"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  const s = await finishMfa(BASE, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: null }));
  return clientFor(s.accessToken);
}

const colombo = (d: Date) => new Date(d.getTime() + 19_800_000).toISOString().slice(0, 10);
const DAYS = 30;
const today = colombo(new Date());
const firstDay = colombo(new Date(Date.now() - (DAYS - 1) * 86_400_000));
const since = new Date(`${firstDay}T00:00:00+05:30`);

/** The same figures, re-derived in JS from raw rows — independent of the SQL group-by. */
async function expected(filter: { merchantId?: string; branchId?: string }) {
  const scope = filter.merchantId ? eq(parcel.merchantId, filter.merchantId) : filter.branchId ? eq(parcel.branchId, filter.branchId) : undefined;
  const parcels = await db.select().from(parcel).where(scope ? and(scope, gte(parcel.createdAt, since)) : gte(parcel.createdAt, since));
  const events = await db
    .select({ ts: parcelEvent.ts, to: parcelEvent.toStatus, id: parcel.id, cod: parcel.codAmountCents })
    .from(parcelEvent)
    .innerJoin(parcel, eq(parcel.id, parcelEvent.parcelId))
    .where(and(scope, gte(parcelEvent.ts, since), inArray(parcelEvent.toStatus, ["Delivered", "DeliveryAttempted", "RTOInitiated"])));
  const t = { booked: parcels.length, bookedCodCents: 0, delivered: 0, deliveredCodCents: 0, attempted: 0, rto: 0 };
  for (const p of parcels) t.bookedCodCents += p.codAmountCents ?? 0;
  const seen = new Set<string>();
  for (const e of events) {
    const k = `${colombo(e.ts)}|${e.to}|${e.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (e.to === "Delivered") { t.delivered += 1; t.deliveredCodCents += e.cod ?? 0; }
    else if (e.to === "DeliveryAttempted") t.attempted += 1;
    else t.rto += 1;
  }
  return t;
}

type Trends = Awaited<ReturnType<AppRouterClient["parcels"]["trends"]>>;
function shapeOk(label: string, tr: Trends) {
  const dates = tr.days.map((d) => d.date);
  check(dates.length === DAYS && dates[0] === firstDay && dates.at(-1) === today, `${label}: ${DAYS} consecutive Colombo days, ${firstDay} → ${today}`, `${dates[0]} … ${dates.at(-1)} (${dates.length})`);
  check(new Set(dates).size === DAYS, `${label}: no duplicate day`);
}

console.log(`\nNatEx Round 6 dashboards probe → ${BASE}  (window ${firstDay} → ${today})\n`);

const admin = await login("+94773456789");
const finance = await login("+94774567890");
const merchant = await login("+94775678901");
const opsCmb = await login("+94772345678");
const rider = await login("+94771234567");
const transport = await login("+94776789012");

console.log("1. parcels.trends — scope and figures");
for (const [label, client, filter] of [
  ["admin (network)", admin, {}],
  ["merchant mch_ceylon_threads", merchant, { merchantId: "mch_ceylon_threads" }],
  ["ops brn_cmb_central", opsCmb, { branchId: "brn_cmb_central" }],
] as const) {
  const tr = await client.parcels.trends({ days: DAYS });
  shapeOk(label, tr);
  const want = await expected(filter);
  check(JSON.stringify(tr.totals) === JSON.stringify(want), `${label}: totals equal the raw rows`, JSON.stringify(tr.totals));
  const out = tr.totals.delivered + tr.totals.attempted;
  check(tr.successPct === (out ? Math.round((tr.totals.delivered / out) * 100) : null), `${label}: success % = delivered ÷ (delivered + attempted)`, String(tr.successPct));
  const sumDays = tr.days.reduce((s, d) => s + d.booked, 0);
  check(sumDays === tr.totals.booked, `${label}: daily booked sums to the total`, `${sumDays}`);
}
const net = await admin.parcels.trends({ days: DAYS });
const mine = await merchant.parcels.trends({ days: DAYS });
check(net.totals.booked > mine.totals.booked && mine.totals.booked > 0, "merchant sees a strict, non-empty subset of the network", `${mine.totals.booked} of ${net.totals.booked}`);
await expectStatus("days below 7 is refused (400)", 400, () => admin.parcels.trends({ days: 3 }));
await expectStatus("days above 90 is refused (400)", 400, () => admin.parcels.trends({ days: 120 }));
await expectStatus("anonymous trends is refused (401)", 401, () => anon.parcels.trends({ days: 30 }));

console.log("\n2. cod.dailyFlow — desk only, ledger-exact");
const flow = await finance.cod.dailyFlow({ days: DAYS });
check(flow.length === DAYS && flow[0]!.date === firstDay && flow.at(-1)!.date === today, `${DAYS} days filled`);
const rows = await db.select().from(codEntry).where(gte(codEntry.ts, since));
const want = { collectedCents: 0, depositedCents: 0, bankedCents: 0, settledCents: 0 };
for (const e of liveEntries(rows)) {
  if (e.type === "COLLECT") want.collectedCents += e.amountCents;
  else if (e.type === "DEPOSIT") want.depositedCents += e.amountCents;
  else if (e.type === "BANK") want.bankedCents += e.amountCents;
  else if (e.type === "SETTLE") want.settledCents += e.amountCents;
}
const got = flow.reduce((s, d) => ({
  collectedCents: s.collectedCents + d.collectedCents,
  depositedCents: s.depositedCents + d.depositedCents,
  bankedCents: s.bankedCents + d.bankedCents,
  settledCents: s.settledCents + d.settledCents,
}), { collectedCents: 0, depositedCents: 0, bankedCents: 0, settledCents: 0 });
check(JSON.stringify(got) === JSON.stringify(want), "window totals equal the live ledger entries", JSON.stringify(got));
check(flow.every((d) => Object.values(d).every((v) => typeof v === "string" || Number.isInteger(v))), "all amounts are integer cents");
for (const [label, c] of [["merchant", merchant], ["rider", rider], ["transport", transport]] as const) {
  await expectStatus(`${label} is refused cod.dailyFlow (403)`, 403, () => c.cod.dailyFlow({ days: 30 }));
}

console.log("\n3. dashboard.company — admin only, consistent with its sources");
const d = await admin.dashboard.company({ days: DAYS });
const [summary, recon] = await Promise.all([admin.parcels.summary(), finance.cod.reconciliation({})]);
check(d.summary.total === summary.total, "summary total = parcels.summary", `${d.summary.total}`);
check(JSON.stringify(d.trends.totals) === JSON.stringify(net.totals), "trends = parcels.trends (admin)");
for (const k of ["collectedCents", "depositedCents", "bankedCents", "settledCents", "inRiderHandsCents", "ledgerSumCents"] as const) {
  check(d.cash[k] === recon[k], `cash.${k} = cod.reconciliation`, `${d.cash[k]}`);
}
check(d.cash.ledgerSumCents === 0, "ledger sums to zero");
const branchTotal = d.branches.reduce((s, b) => s + b.open + b.closed, 0);
check(branchTotal === summary.total, "branch split covers every parcel exactly once", `${branchTotal}`);
check(d.branches.every((b) => b.name && b.name !== b.branchId), "every branch has a resolved name", d.branches.map((b) => b.name).join(", "));
check(d.topMerchants.length > 0 && d.topMerchants.every((m) => m.name !== m.merchantId), "top merchants carry names", d.topMerchants.map((m) => `${m.name} ${m.parcels}`).join(", "));
check(d.topMerchants.every((m, i, a) => i === 0 || a[i - 1]!.parcels >= m.parcels), "top merchants sorted by parcels");
check(d.people.total > 0 && d.people.byRole.reduce((s, r) => s + r.active + r.suspended, 0) === d.people.total, "people by role adds up", `${d.people.total}`);
check(d.flow.length === DAYS, "flow window filled");
for (const [label, c] of [["finance", finance], ["ops", opsCmb], ["merchant", merchant], ["rider", rider]] as const) {
  await expectStatus(`${label} is refused dashboard.company (403)`, 403, () => c.dashboard.company({ days: 30 }));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
