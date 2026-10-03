import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { and, count, eq, inArray, like, lt, ne } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

/**
 * Live probe of the paged, scoped read routes behind /ops/runsheets and
 * /ops/ndr (§10 M3, §11 server-side pagination, §5 scoping) over HTTP.
 *
 * Proves, against counts taken straight from the DB:
 *   - delivery.runsheetPage, ndr.page, ndr.rtoPage return honest totals and
 *     walk their pages without overlap or loss;
 *   - ndr.counts / ndr.rtoCounts / delivery.counts agree with SQL;
 *   - overdue filtering happens in SQL (every overdue row, none that is not);
 *   - §5: merchant → runsheets 403; merchant naming another merchant → 403;
 *     another merchant's NDR / RTO by id → 404; rider asking for another
 *     rider's runs → 403; another branch's NDR / RTO / runsheet by id → 403;
 *   - ndr.rtoGet returns {rto, parcel, merchantName, pod}.
 *
 * Run: bun --env-file=../../.env scripts/probe-ops-delivery.ts
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4200";
const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { ndr, rto, runsheet } = await import("../src/api/database/schema/delivery");
const { colomboToday } = await import("../src/api/shared/time");
await db.delete(rateLimit);

function clientFor(token?: string): AppRouterClient {
  return createORPCClient(
    new RPCLink({
      url: `${BASE}/api/rpc`,
      headers: () => (token ? { authorization: `Bearer ${token}` } : {}),
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
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
async function expectFail(label: string, status: number, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(false, label, "expected a refusal, got success");
  } catch (err) {
    const e = err as { status?: number; data?: { status?: number; type?: string }; message?: string };
    const got = e.data?.status ?? e.status;
    check(got === status, label, `${got} ${e.data?.type ?? ""} ${e.message ?? ""}`.trim());
  }
}
async function login(phone: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return finishMfa(BASE, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: null }));
}
const n = async (q: Promise<{ value: number }[]>) => (await q)[0]?.value ?? 0;

/** Walk every page; assert no id appears twice and the union equals `total`. */
async function walk<T extends { id: string }>(
  label: string,
  fetch: (page: number) => Promise<{ rows: T[]; total: number; page: number; pageSize: number }>,
  expected: number,
) {
  const first = await fetch(1);
  check(first.total === expected, `${label}: total matches SQL`, `api ${first.total}, db ${expected}`);
  const seen = new Set<string>();
  const pages = Math.ceil(first.total / first.pageSize);
  for (let p = 1; p <= Math.min(pages, 40); p += 1) {
    const r = p === 1 ? first : await fetch(p);
    for (const row of r.rows) seen.add(row.id);
  }
  check(
    seen.size === Math.min(first.total, 40 * first.pageSize),
    `${label}: pages walk without overlap or loss`,
    `${pages} page(s) of ${first.pageSize}, ${seen.size} distinct`,
  );
  const past = await fetch(pages + 1);
  check(past.rows.length === 0 && past.total === first.total, `${label}: a page past the end is empty, total unchanged`);
  return first;
}

const KDY = "brn_kdy_hub";
const CEYLON = "mch_ceylon_threads";
const GADGETS = "mch_lanka_gadgets";

console.log(`\nOps delivery read-surface probe → ${BASE}\n`);
const kdyOps = await login("+94779012345");
const cmbOps = await login("+94772345678");
const admin = await login("+94773456789");
const merchantUser = await login("+94775678901");
const kdyRider = await login("+94778901234");
const cmbRider = await login("+94771234567");
const kdyTransport = await login("+94777890123");
check(kdyOps.user.role === "ops" && merchantUser.user.role === "merchant", "seven roles signed in");

const kOps = clientFor(kdyOps.accessToken);
const cOps = clientFor(cmbOps.accessToken);
const adm = clientFor(admin.accessToken);
const mch = clientFor(merchantUser.accessToken);
const kRider = clientFor(kdyRider.accessToken);
const kTrans = clientFor(kdyTransport.accessToken);

// ── 1. Runsheet register ──────────────────────────────────────────────────────
console.log("1. delivery.runsheetPage");
const kdyRuns = await n(db.select({ value: count() }).from(runsheet).where(eq(runsheet.branchId, KDY)));
await walk("Kandy ops runsheets", (page) => kOps.delivery.runsheetPage({ page, pageSize: 7 }), kdyRuns);
const allRuns = await n(db.select({ value: count() }).from(runsheet));
await walk("admin runsheets (global)", (page) => adm.delivery.runsheetPage({ page, pageSize: 25 }), allRuns);
const closedKdy = await n(
  db.select({ value: count() }).from(runsheet).where(and(eq(runsheet.branchId, KDY), eq(runsheet.status, "closed"))),
);
const closedPage = await kOps.delivery.runsheetPage({ status: ["closed"], page: 1, pageSize: 100 });
check(
  closedPage.total === closedKdy && closedPage.rows.every((r) => r.status === "closed"),
  "status filter applied in SQL",
  `${closedPage.total} closed`,
);
const sample = closedPage.rows[0];
if (sample) {
  const found = await kOps.delivery.runsheetPage({ search: sample.code.slice(-6), page: 1, pageSize: 25 });
  check(found.rows.some((r) => r.id === sample.id), "search finds a run by code fragment", sample.code);
}
const ordered = closedPage.rows.every((r, i, a) => i === 0 || a[i - 1]!.runDate >= r.runDate);
check(ordered, "newest run date first");

const ownRider = await kRider.delivery.runsheetPage({ page: 1, pageSize: 100 });
check(
  ownRider.rows.every((r) => r.riderId === kdyRider.user.id),
  "a rider's register holds only their own runs",
  `${ownRider.total} run(s)`,
);
await expectFail("a rider asking for another rider's runs is refused (§5)", 403, () =>
  kRider.delivery.runsheetPage({ riderId: cmbRider.user.id, page: 1, pageSize: 10 }),
);
await expectFail("a merchant cannot read the runsheet register", 403, () =>
  mch.delivery.runsheetPage({ page: 1, pageSize: 10 }),
);
const tPage = await kTrans.delivery.runsheetPage({ page: 1, pageSize: 5 });
check(tPage.total === kdyRuns, "transport reads its own hub's register (it builds the runs)", `${tPage.total}`);

const [foreignRun] = await db.select().from(runsheet).where(ne(runsheet.branchId, KDY)).limit(1);
const [kdyRun] = await db.select().from(runsheet).where(eq(runsheet.branchId, KDY)).limit(1);
if (foreignRun) {
  await expectFail("Kandy ops cannot open another branch's runsheet", 403, () =>
    kOps.delivery.runsheetGet({ runsheetId: foreignRun.id }),
  );
} else if (kdyRun) {
  await expectFail("Colombo ops cannot open a Kandy runsheet", 403, () =>
    cOps.delivery.runsheetGet({ runsheetId: kdyRun.id }),
  );
}

const today = colomboToday();
const todays = await db
  .select()
  .from(runsheet)
  .where(and(eq(runsheet.branchId, KDY), eq(runsheet.runDate, today)));
const dc = await kOps.delivery.counts({});
check(
  dc.runsheetsToday === todays.length &&
    dc.stopsPlanned === todays.reduce((a, s) => a + s.plannedCount, 0) &&
    dc.codCollectedCents === todays.reduce((a, s) => a + s.codCollectedCents, 0),
  "delivery.counts is today's runs only, summed exactly",
  `${dc.runsheetsToday} run(s), ${dc.stopsPlanned} stops, ${dc.codCollectedCents}c collected`,
);

// ── 2. NDR queue ──────────────────────────────────────────────────────────────
console.log("\n2. ndr.page / ndr.counts");
const LIVE = ["open", "instructed", "reattempt_scheduled"];
const kdyNdr = await n(db.select({ value: count() }).from(ndr).where(eq(ndr.branchId, KDY)));
await walk("Kandy NDR queue", (page) => kOps.ndr.page({ page, pageSize: 3 }), kdyNdr);
const allNdr = await n(db.select({ value: count() }).from(ndr));
await walk("admin NDR queue (global)", (page) => adm.ndr.page({ page, pageSize: 10 }), allNdr);

const firstPage = await kOps.ndr.page({ page: 1, pageSize: 100 });
check(
  firstPage.rows.every((r, i, a) => i === 0 || new Date(a[i - 1]!.raisedAt) <= new Date(r.raisedAt)),
  "oldest first (closest to breach at the top)",
);
check(firstPage.rows.every((r) => r.merchantName !== undefined), "rows carry the merchant's display name");

// Fixture: back-date two live Kandy NDRs' SLA clocks by an hour so the overdue
// path is exercised on real rows, not a degenerate empty set. Restored below.
const liveKdy = await db
  .select({ id: ndr.id, slaDueAt: ndr.slaDueAt })
  .from(ndr)
  .where(and(eq(ndr.branchId, KDY), inArray(ndr.state, LIVE)))
  .limit(2);
const hourAgo = new Date(Date.now() - 3_600_000);
for (const r of liveKdy) await db.update(ndr).set({ slaDueAt: hourAgo }).where(eq(ndr.id, r.id));
check(liveKdy.length === 2, "fixture: two live NDRs pushed past their SLA", liveKdy.map((r) => r.id).join(", "));

const now = new Date();
const overdueDb = await db
  .select({ id: ndr.id })
  .from(ndr)
  .where(and(eq(ndr.branchId, KDY), inArray(ndr.state, LIVE), lt(ndr.slaDueAt, now)));
const overdueApi = await kOps.ndr.page({ overdueOnly: true, page: 1, pageSize: 100 });
const overdueIds = new Set(overdueDb.map((r) => r.id));
check(
  overdueApi.total === overdueDb.length &&
    overdueApi.rows.every((r) => overdueIds.has(r.id) && r.overdue),
  "overdue filter is decided in SQL, exactly",
  `api ${overdueApi.total}, db ${overdueDb.length}`,
);
const overduePaged = await kOps.ndr.page({ overdueOnly: true, page: 2, pageSize: 1 });
check(
  overduePaged.total === overdueDb.length && overduePaged.rows.length === (overdueDb.length >= 2 ? 1 : 0),
  "page 2 of the overdue filter is still overdue rows, not page 1's leftovers",
);

const kc = await kOps.ndr.counts({});
const byState = await db
  .select({ state: ndr.state, value: count() })
  .from(ndr)
  .where(eq(ndr.branchId, KDY))
  .groupBy(ndr.state);
const of = (s: string) => byState.find((r) => r.state === s)?.value ?? 0;
check(
  kc.open === of("open") &&
    kc.instructed === of("instructed") &&
    kc.reattemptScheduled === of("reattempt_scheduled") &&
    kc.rto === of("rto") &&
    kc.resolved === of("resolved") &&
    kc.closed === of("closed") &&
    kc.total === kdyNdr &&
    kc.overdue === overdueDb.length,
  "ndr.counts agree with a SQL GROUP BY, overdue included",
  JSON.stringify(kc),
);

for (const r of liveKdy) await db.update(ndr).set({ slaDueAt: r.slaDueAt }).where(eq(ndr.id, r.id));

const mNdr = await mch.ndr.page({ page: 1, pageSize: 100 });
const ceylonNdr = await n(db.select({ value: count() }).from(ndr).where(eq(ndr.merchantId, CEYLON)));
check(
  mNdr.total === ceylonNdr && mNdr.rows.every((r) => r.merchantId === CEYLON),
  "a merchant's queue is exactly its own NDRs (§5)",
  `${mNdr.total}`,
);
await expectFail("a merchant naming another merchant on ndr.page is refused (§5)", 403, () =>
  mch.ndr.page({ merchantId: GADGETS, page: 1, pageSize: 10 }),
);
await expectFail("…and on ndr.list", 403, () => mch.ndr.list({ merchantId: GADGETS }));
const mc = await mch.ndr.counts({});
check(mc.total === ceylonNdr, "a merchant's tallies count only its own rows", `${mc.total}`);

const [otherMerchantNdr] = await db.select().from(ndr).where(ne(ndr.merchantId, CEYLON)).limit(1);
if (otherMerchantNdr) {
  await expectFail("another merchant's NDR by id is not found, not forbidden (§5)", 404, () =>
    mch.ndr.get({ ndrId: otherMerchantNdr.id }),
  );
}
const [foreignNdr] = await db.select().from(ndr).where(ne(ndr.branchId, KDY)).limit(1);
const [kdyNdrRow] = await db.select().from(ndr).where(eq(ndr.branchId, KDY)).limit(1);
if (foreignNdr) {
  await expectFail("Kandy ops cannot read another branch's NDR", 403, () => kOps.ndr.get({ ndrId: foreignNdr.id }));
} else if (kdyNdrRow) {
  await expectFail("Colombo ops cannot read a Kandy NDR", 403, () => cOps.ndr.get({ ndrId: kdyNdrRow.id }));
}
if (kdyNdrRow) {
  const awbHit = await kOps.ndr.page({ search: kdyNdrRow.awb.slice(-5), page: 1, pageSize: 50 });
  check(awbHit.rows.some((r) => r.id === kdyNdrRow.id), "AWB search finds the NDR", kdyNdrRow.awb);
  const d = await kOps.ndr.get({ ndrId: kdyNdrRow.id });
  check(
    d.ndr.id === kdyNdrRow.id && d.parcel.awb === kdyNdrRow.awb && "overdue" in d && "rto" in d,
    "ndr.get returns {ndr, parcel, merchantName, rto, overdue}",
  );
}

// ── 3. RTO register ──────────────────────────────────────────────────────────
console.log("\n3. ndr.rtoPage / ndr.rtoGet / ndr.rtoCounts");
const kdyRto = await n(db.select({ value: count() }).from(rto).where(eq(rto.branchId, KDY)));
await walk("Kandy RTO register", (page) => kOps.ndr.rtoPage({ page, pageSize: 2 }), kdyRto);
const rc = await kOps.ndr.rtoCounts({});
const rtoByState = await db
  .select({ state: rto.state, value: count() })
  .from(rto)
  .where(eq(rto.branchId, KDY))
  .groupBy(rto.state);
const rof = (s: string) => rtoByState.find((r) => r.state === s)?.value ?? 0;
check(
  rc.initiated === rof("initiated") && rc.inTransit === rof("in_transit") && rc.delivered === rof("delivered") && rc.total === kdyRto,
  "rto counts agree with SQL",
  JSON.stringify(rc),
);
const mRto = await mch.ndr.rtoPage({ page: 1, pageSize: 100 });
check(mRto.rows.every((r) => r.merchantId === CEYLON), "a merchant's returns are only its own", `${mRto.total}`);
await expectFail("a merchant naming another merchant on rtoPage is refused", 403, () =>
  mch.ndr.rtoPage({ merchantId: GADGETS, page: 1, pageSize: 10 }),
);

const [otherMerchantRto] = await db.select().from(rto).where(ne(rto.merchantId, CEYLON)).limit(1);
if (otherMerchantRto) {
  await expectFail("another merchant's return by id is 404 (the old leak is closed)", 404, () =>
    mch.ndr.rtoGet({ rtoId: otherMerchantRto.id }),
  );
}
const [ownRto] = await db.select().from(rto).where(eq(rto.merchantId, CEYLON)).limit(1);
if (ownRto) {
  const own = await mch.ndr.rtoGet({ rtoId: ownRto.id });
  check(own.rto.id === ownRto.id && own.parcel?.awb === ownRto.awb, "a merchant reads its own return");
}
const [deliveredRto] = await db.select().from(rto).where(and(eq(rto.branchId, KDY), eq(rto.state, "delivered"))).limit(1);
if (deliveredRto) {
  const d = await kOps.ndr.rtoGet({ rtoId: deliveredRto.id });
  check(Boolean(d.pod) && typeof d.merchantName === "string", "a handed-back return carries its POD and merchant name", d.pod?.method ?? "");
}
const [foreignRto] = await db.select().from(rto).where(ne(rto.branchId, KDY)).limit(1);
const [kdyRtoRow] = await db.select().from(rto).where(eq(rto.branchId, KDY)).limit(1);
if (foreignRto) {
  await expectFail("Kandy ops cannot read another branch's return", 403, () => kOps.ndr.rtoGet({ rtoId: foreignRto.id }));
} else if (kdyRtoRow) {
  await expectFail("Colombo ops cannot read a Kandy return", 403, () => cOps.ndr.rtoGet({ rtoId: kdyRtoRow.id }));
}

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`ops delivery read-surface probe: ${pass}/${pass} checks passed\n`);
  process.exit(0);
}
console.log(`ops delivery read-surface probe: ${pass} passed, ${failures.length} FAILED`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
