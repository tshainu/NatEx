import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { and, count, eq, inArray, like, notInArray, sql } from "drizzle-orm";
import type { AppRouterClient } from "../src/api";

/**
 * Live probe of the merchant-portal backend (§10 M3 "Merchant portal:
 * dashboard, booking, bulk upload, pickups, shipments, tracking") over HTTP
 * against the running dev server, every number checked against SQL.
 *
 *   parcels.summary            dashboard tallies = SQL, per scope
 *   parcels.list               a merchant naming another merchant → 403 (§5)
 *   collection.requestPickup   date window, foreign/non-Booked/double-booked
 *                              AWBs refused with reasons, idempotent replay,
 *                              Idempotency-Key required, 403 on another merchant
 *   collection.pickupRequests  merchant-scoped, branch-scoped for ops, counts = SQL
 *   collection.cancelPickupRequest  reason required, 409 once not `requested`
 *   collection.create          ops answers a request → `scheduled` + manifest
 *                              link; a second answer → 409
 *   collection.list / get      merchant reads its own manifests; another
 *                              merchant's → 403 by filter, 404 by id
 *
 * Run: bun --env-file=../../.env scripts/probe-merchant-portal.ts
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4200";
const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit, auditLog } = await import("../src/api/database/schema/shared");
const { parcel, parcelEvent } = await import("../src/api/database/schema/parcels");
const { pickupRequest } = await import("../src/api/database/schema/collection");
const { TERMINAL_STATUSES } = await import("../src/api/modules/parcels/state-machine");
const { colomboToday, addDays } = await import("../src/api/shared/time");
await db.delete(rateLimit);

let keySeq = 0;
const key = (l: string) => `mportal-${l}-${Date.now()}-${++keySeq}`;
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
async function expectFail(label: string, status: number, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    check(false, label, "expected a refusal, got success");
  } catch (err) {
    const e = err as { status?: number; data?: { status?: number; type?: string }; message?: string };
    const got = e.data?.status ?? e.status;
    const ok = got === status && (!match || match.test(e.message ?? ""));
    check(ok, label, `${got} ${e.message ?? ""}`.trim().slice(0, 200));
  }
}
async function login(phone: string) {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: "mportal-probe" });
}

const OWN = "mch_ceylon_threads";
const OTHER = "mch_lanka_gadgets";
const merchantS = await login("+94775678901");
const cmbOps = await login("+94772345678");
const kdyOps = await login("+94779012345");
const m = clientFor(merchantS.accessToken);
const ops = clientFor(cmbOps.accessToken);
const kdy = clientFor(kdyOps.accessToken);
const today = colomboToday();

console.log(`\nmerchant portal probe → ${BASE}\n`);

// ── dashboard summary ──────────────────────────────────────────────────────
console.log("parcels.summary");
{
  const s = await m.parcels.summary();
  const own = eq(parcel.merchantId, OWN);
  const [total] = await db.select({ v: count() }).from(parcel).where(own);
  const [open] = await db
    .select({ v: count(), cod: sql<number>`coalesce(sum(${parcel.codAmountCents}),0)` })
    .from(parcel)
    .where(and(own, notInArray(parcel.status, TERMINAL_STATUSES as unknown as string[])));
  const dayStart = Math.floor(new Date(`${today}T00:00:00+05:30`).getTime() / 1000);
  const [booked] = await db
    .select({ v: count() })
    .from(parcel)
    .where(and(own, sql`${parcel.createdAt} >= ${dayStart}`));
  const since = Math.floor((Date.now() - 30 * 86_400_000) / 1000);
  const delivered = await db
    .selectDistinct({ id: parcel.id, cod: parcel.codAmountCents })
    .from(parcelEvent)
    .innerJoin(parcel, eq(parcel.id, parcelEvent.parcelId))
    .where(and(own, eq(parcelEvent.toStatus, "Delivered"), sql`${parcelEvent.ts} >= ${since}`));
  check(s.total === total!.v, "total = SQL count for this merchant", `${s.total}`);
  check(s.open === open!.v, "open (non-terminal) = SQL", `${s.open}`);
  check(s.codOpenCents === Number(open!.cod), "COD still to collect = SQL sum, integer cents", `${s.codOpenCents}c`);
  check(Number.isInteger(s.codOpenCents), "COD is an integer");
  check(s.bookedToday === booked!.v, "booked today (Asia/Colombo day) = SQL", `${s.bookedToday}`);
  check(s.last30d.delivered === delivered.length, "delivered in 30 days = SQL distinct parcels", `${s.last30d.delivered}`);
  check(
    s.last30d.deliveredCodCents === delivered.reduce((n, r) => n + r.cod, 0),
    "COD on those deliveries = SQL sum",
    `${s.last30d.deliveredCodCents}c`,
  );
  check(s.byStatus.reduce((n, r) => n + r.count, 0) === s.total, "status tallies add up to the total");
  const opsS = await ops.parcels.summary();
  const [branchTotal] = await db.select({ v: count() }).from(parcel).where(eq(parcel.branchId, "brn_cmb_central"));
  check(opsS.total === branchTotal!.v, "ops summary is branch-scoped, not merchant-scoped", `${opsS.total}`);
}

console.log("\nparcels.list §5");
await expectFail("merchant naming another merchant on parcels.list → 403", 403, () =>
  m.parcels.list({ page: 1, pageSize: 5, merchantId: OTHER }),
);
{
  const r = await m.parcels.list({ page: 1, pageSize: 5, merchantId: OWN });
  check(r.rows.every((p) => p.merchantId === OWN), "merchant naming itself is allowed and scoped", `${r.total}`);
}

// ── fixtures: fresh Booked parcels, booked BY the merchant ─────────────────
async function book(client: AppRouterClient, merchantId: string, label: string) {
  const created = await clientFor(
    client === m ? merchantS.accessToken : cmbOps.accessToken,
    key(`book-${label}`),
  ).parcels.create({
    merchantId,
    weightGrams: 450,
    declaredValueCents: 150_000,
    codAmountCents: merchantId === OWN ? 0 : 0,
    originAddress: "45 Galle Road, Colombo 03",
    consigneeName: `Portal Probe ${label}`,
    consigneePhone: "+94761234567",
    destAddress: `${label} Temple Road, Nugegoda`,
  });
  return created.parcel.awb;
}
const mine = [await book(m, OWN, "A"), await book(m, OWN, "B"), await book(m, OWN, "C")];
const second = [await book(m, OWN, "D"), await book(m, OWN, "E")];
const foreign = await book(ops, OTHER, "F");
const [notBooked] = await db
  .select({ awb: parcel.awb })
  .from(parcel)
  .where(and(eq(parcel.merchantId, OWN), eq(parcel.status, "Delivered")))
  .limit(1);
console.log(`\nfixtures: own ${mine.join(", ")} + ${second.join(", ")}; foreign ${foreign}`);

// ── request a pickup ────────────────────────────────────────────────────────
console.log("\ncollection.requestPickup");
const tomorrow = addDays(today, 1);
const req = (k: string) => clientFor(merchantS.accessToken, k).collection;
await expectFail("no Idempotency-Key → 400", 400, () =>
  m.collection.requestPickup({ merchantId: OWN, pickupDate: tomorrow, window: "morning", awbs: mine }),
);
await expectFail("a date in the past → 400", 400, () =>
  req(key("past")).requestPickup({ merchantId: OWN, pickupDate: addDays(today, -1), window: "morning", awbs: mine }),
  /in the past/,
);
await expectFail("more than 14 days ahead → 400", 400, () =>
  req(key("far")).requestPickup({ merchantId: OWN, pickupDate: addDays(today, 15), window: "morning", awbs: mine }),
  /14 days/,
);
await expectFail("for another merchant → 403", 403, () =>
  req(key("other")).requestPickup({ merchantId: OTHER, pickupDate: tomorrow, window: "morning", awbs: [foreign] }),
);
await expectFail("another merchant's AWB reads as not found → 400", 400, () =>
  req(key("foreign")).requestPickup({ merchantId: OWN, pickupDate: tomorrow, window: "morning", awbs: [mine[0]!, foreign] }),
  new RegExp(`${foreign} not found on this account`),
);
if (notBooked) {
  await expectFail("a delivered parcel cannot be picked up → 400", 400, () =>
    req(key("delivered")).requestPickup({ merchantId: OWN, pickupDate: tomorrow, window: "morning", awbs: [notBooked.awb] }),
    /already Delivered/,
  );
}
const kReq = key("happy");
const first = await req(kReq).requestPickup({
  merchantId: OWN,
  pickupDate: tomorrow,
  window: "afternoon",
  awbs: [...mine, mine[0]!.toLowerCase()],
  notes: "Gate 2, ask for the stores clerk",
});
check(first.status === "requested" && first.parcelCount === 3, "happy path: requested, duplicates folded to 3 parcels", first.code);
check(first.branchId === "brn_cmb_central", "request lands at the merchant's own branch");
const replay = await req(kReq).requestPickup({
  merchantId: OWN,
  pickupDate: tomorrow,
  window: "afternoon",
  awbs: [...mine, mine[0]!.toLowerCase()],
  notes: "Gate 2, ask for the stores clerk",
});
check(replay.id === first.id, "same Idempotency-Key replays the stored result, no second row");
const [rows] = await db.select({ v: count() }).from(pickupRequest).where(eq(pickupRequest.code, first.code));
check(rows!.v === 1, "exactly one row in the DB for that request");
await expectFail("the same AWB on a second live request → 400", 400, () =>
  req(key("double")).requestPickup({ merchantId: OWN, pickupDate: tomorrow, window: "morning", awbs: [mine[1]!] }),
  new RegExp(`already on pickup request ${first.code}`),
);
const [audit] = await db
  .select({ v: count() })
  .from(auditLog)
  .where(and(eq(auditLog.entityId, first.id), eq(auditLog.action, "pickup.requested")));
check(audit!.v === 1, "one audit row for the request", `${audit!.v}`);

// ── lists, counts, scoping ─────────────────────────────────────────────────
console.log("\ncollection.pickupRequests / counts");
{
  const list = await m.collection.pickupRequests({ page: 1, pageSize: 100 });
  const [sqlTotal] = await db.select({ v: count() }).from(pickupRequest).where(eq(pickupRequest.merchantId, OWN));
  check(list.total === sqlTotal!.v, "merchant list total = SQL", `${list.total}`);
  check(list.rows.every((r) => r.merchantId === OWN), "every row is this merchant's");
  check(list.rows.some((r) => r.id === first.id && r.awbs.length === 3), "the new request is listed with its AWBs");
  const c = await m.collection.pickupRequestCounts({});
  const byStatus = await db
    .select({ s: pickupRequest.status, v: count() })
    .from(pickupRequest)
    .where(eq(pickupRequest.merchantId, OWN))
    .groupBy(pickupRequest.status);
  const want = Object.fromEntries(byStatus.map((r) => [r.s, r.v]));
  check(
    c.requested === (want.requested ?? 0) && c.scheduled === (want.scheduled ?? 0) && c.cancelled === (want.cancelled ?? 0),
    "counts = SQL GROUP BY",
    JSON.stringify(c),
  );
  await expectFail("merchant naming another merchant on pickupRequests → 403", 403, () =>
    m.collection.pickupRequests({ page: 1, pageSize: 5, merchantId: OTHER }),
  );
  await expectFail("merchant naming another merchant on counts → 403", 403, () =>
    m.collection.pickupRequestCounts({ merchantId: OTHER }),
  );
  const kList = await kdy.collection.pickupRequests({ page: 1, pageSize: 100 });
  check(!kList.rows.some((r) => r.id === first.id), "Kandy ops does not see a Colombo request");
  await expectFail("Kandy ops reading it by id → 403", 403, () => kdy.collection.pickupRequestGet({ id: first.id }));
  const oList = await ops.collection.pickupRequests({ page: 1, pageSize: 100, status: ["requested"] });
  check(oList.rows.some((r) => r.id === first.id), "Colombo ops sees it in the requested queue");
}

// another merchant's request, booked by ops on its behalf
const foreignReq = await clientFor(cmbOps.accessToken, key("foreign-req")).collection.requestPickup({
  merchantId: OTHER,
  pickupDate: tomorrow,
  window: "morning",
  awbs: [foreign],
});
check(foreignReq.status === "requested", "ops can request on a merchant's behalf", foreignReq.code);
await expectFail("merchant reading another merchant's request by id → 404", 404, () =>
  m.collection.pickupRequestGet({ id: foreignReq.id }),
);
await expectFail("merchant cancelling another merchant's request → 404", 404, () =>
  req(key("cancel-foreign")).cancelPickupRequest({ id: foreignReq.id, reason: "not mine to cancel" }),
);

// ── cancel ─────────────────────────────────────────────────────────────────
console.log("\ncollection.cancelPickupRequest");
await expectFail("a reason under 5 chars → 400", 400, () =>
  req(key("cancel-short")).cancelPickupRequest({ id: first.id, reason: "no" }),
);
const cancelled = await req(key("cancel")).cancelPickupRequest({ id: first.id, reason: "Stock not packed in time" });
check(cancelled.status === "cancelled" && cancelled.cancelReason === "Stock not packed in time", "cancelled with its reason");
await expectFail("cancelling twice → 409", 409, () =>
  req(key("cancel-again")).cancelPickupRequest({ id: first.id, reason: "Stock not packed in time" }),
);
const again = await req(key("re-request")).requestPickup({ merchantId: OWN, pickupDate: tomorrow, window: "morning", awbs: [mine[0]!] });
check(again.status === "requested", "a cancelled request frees its AWBs for a new one", again.code);

// ── ops answers a request with a manifest ─────────────────────────────────
console.log("\ncollection.create ← pickupRequestId");
const second_ = await req(key("second")).requestPickup({ merchantId: OWN, pickupDate: tomorrow, window: "morning", awbs: second });
const riders = await ops.identity.listRiders();
const rider = riders[0]!;
await expectFail("Kandy ops cannot answer a Colombo request → 403", 403, () =>
  clientFor(kdyOps.accessToken, key("kdy-answer")).collection.create({
    merchantId: OWN,
    riderId: rider.id,
    pickupDate: tomorrow,
    awbs: second,
    pickupRequestId: second_.id,
  }),
);
await expectFail("answering with another merchant's request → 400", 400, () =>
  clientFor(cmbOps.accessToken, key("mismatch")).collection.create({
    merchantId: OWN,
    riderId: rider.id,
    pickupDate: tomorrow,
    awbs: second,
    pickupRequestId: foreignReq.id,
  }),
);
const manifestRes = await clientFor(cmbOps.accessToken, key("answer")).collection.create({
  merchantId: OWN,
  riderId: rider.id,
  pickupDate: tomorrow,
  awbs: second,
  pickupRequestId: second_.id,
});
const linked = await m.collection.pickupRequestGet({ id: second_.id });
check(
  linked.status === "scheduled" && linked.manifestId === manifestRes.manifest.id && linked.manifestCode === manifestRes.manifest.code,
  "request → scheduled, linked to the manifest",
  `${linked.code} → ${linked.manifestCode}`,
);
await expectFail("answering it a second time → 409", 409, () =>
  clientFor(cmbOps.accessToken, key("answer-2")).collection.create({
    merchantId: OWN,
    riderId: rider.id,
    pickupDate: tomorrow,
    awbs: [mine[2]!],
    pickupRequestId: second_.id,
  }),
);
await expectFail("merchant cannot cancel a scheduled request → 409", 409, () =>
  req(key("cancel-scheduled")).cancelPickupRequest({ id: second_.id, reason: "changed my mind" }),
  /rider is already assigned/,
);
await expectFail("a parcel already on a manifest cannot be requested again → 400", 400, () =>
  req(key("on-manifest")).requestPickup({ merchantId: OWN, pickupDate: tomorrow, window: "morning", awbs: [second[0]!] }),
  new RegExp(`already on manifest ${manifestRes.manifest.code}`),
);

// ── merchant reads its manifests ───────────────────────────────────────────
console.log("\ncollection.list / get for a merchant");
{
  const list = await m.collection.list({ page: 1, pageSize: 100 });
  check(list.rows.every((r) => r.merchantId === OWN), "merchant manifest list is scoped to itself", `${list.total}`);
  check(list.rows.some((r) => r.id === manifestRes.manifest.id), "the new manifest is in it");
  const detail = await m.collection.get({ id: manifestRes.manifest.id });
  check(detail.items.length === 2 && detail.items.every((i) => second.includes(i.awb)), "detail lists the two AWBs");
  await expectFail("merchant naming another merchant on collection.list → 403", 403, () =>
    m.collection.list({ page: 1, pageSize: 5, merchantId: OTHER }),
  );
  let [otherManifest] = (await ops.collection.list({ page: 1, pageSize: 100, merchantId: OTHER })).rows;
  if (!otherManifest) {
    const made = await clientFor(cmbOps.accessToken, key("other-manifest")).collection.create({
      merchantId: OTHER,
      riderId: rider.id,
      pickupDate: tomorrow,
      awbs: [await book(ops, OTHER, "G")],
    });
    otherManifest = { ...made.manifest, merchantName: made.merchantName };
  }
  if (otherManifest) {
    await expectFail("merchant reading another merchant's manifest by id → 404", 404, () =>
      m.collection.get({ id: otherManifest.id }),
    );
  } else {
    check(false, "need a manifest for another merchant to prove the 404");
  }
}

// tidy: the requests this probe left live are cancelled through the API
for (const id of [again.id, foreignReq.id]) {
  await clientFor(cmbOps.accessToken, key(`tidy-${id}`)).collection.cancelPickupRequest({
    id,
    reason: "probe fixture, cancelled by the probe",
  });
}
const left = await db
  .select({ v: count() })
  .from(pickupRequest)
  .where(and(inArray(pickupRequest.id, [again.id, foreignReq.id]), eq(pickupRequest.status, "requested")));
check(left[0]!.v === 0, "probe leaves no live request behind");

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`merchant portal probe: ${pass}/${pass} checks passed\n`);
  process.exit(0);
}
console.log(`merchant portal probe: ${pass} passed, ${failures.length} FAILED`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
