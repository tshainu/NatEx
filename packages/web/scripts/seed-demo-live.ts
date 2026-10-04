/**
 * Demo "today" — a believable working day in progress, for the DEMO site.
 *
 * Run AFTER the base seed, seed-m4 and seed-demo-history on a fresh demo DB.
 * Everything goes through the real HTTP API as the people who would do it, so
 * every row (events, runsheets, bags, trips, NDRs, PODs, COD ledger) is exactly
 * what live use writes and the nightly COD invariant stays green:
 *
 *   Colombo   new bookings waiting for pickup, picked up, at the hub; a rider
 *             (Karthik) out on a dispatched run with some stops delivered
 *             (signature and OTP PODs, COD collected), one missed (open NDR)
 *             and the rest still out for delivery.
 *   Linehaul  one sealed bag on a trip that has departed for Kandy (InTransit).
 *   Kandy     a received bag, a rider (Senthil) out with deliveries, two
 *             missed (open NDRs), parcels waiting at the hub for tomorrow.
 *
 * DEV/DEMO ONLY: the API must be in development mode (dev OTP codes); the
 * script refuses otherwise, and refuses NODE_ENV=production locally.
 *
 *   SEED_API=https://demo.… bun --env-file=<demo env> scripts/seed-demo-live.ts
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "../src/api";
import { inArray, eq } from "drizzle-orm";
import { isDevelopment } from "../src/api/shared/env";
import { bankRiderCash } from "./lib/cash";
import { finishMfa } from "./lib/mfa";
import { CMB_BRANCH, KDY_HUB } from "./lib/rail";

if (!isDevelopment()) throw new Error("Refusing to seed demo activity outside NODE_ENV=development/test.");
const BASE = process.env.SEED_API ?? "http://localhost:4200";

const { db } = await import("../src/api/database");
const { rateLimit } = await import("../src/api/database/schema/shared");
await db.delete(rateLimit);

let seq = 0;
const key = (l: string) => `demo-live-${l}-${Date.now()}-${++seq}`;
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
const env = await anon.identity.environment();
if (!env.demo) throw new Error(`${BASE} is not a demo/development server — refusing.`);

async function login(phone: string) {
  await db.delete(rateLimit);
  const c = await anon.identity.requestOtp({ phone });
  if (!c.devCode) throw new Error(`no dev OTP for ${phone}`);
  return finishMfa(BASE, await anon.identity.verifyOtp({ challengeId: c.challengeId, code: c.devCode, deviceId: "demo-live" }));
}

const admin = await login("+94773456789");
const cmbOps = await login("+94772345678");
const kdyOps = await login("+94779012345");
const cmbRider = await login("+94771234567");
const kdyRider = await login("+94778901234");
const cmbVan = await login("+94776789012");
const kdyVan = await login("+94777890123");

const THREADS = { id: "mch_ceylon_threads", origin: "44 Galle Road, Colombo 04", pod: "signature" as const };
const GADGETS = { id: "mch_lanka_gadgets", origin: "12 Stanley Thilakaratne Mw, Nugegoda", pod: "otp" as const };

type Booking = { m: typeof THREADS | typeof GADGETS; name: string; phone: string; to: string; cod: number; grams: number };
const COLOMBO: Booking[] = [
  { m: THREADS, name: "Anushka Rathnayake", phone: "+94771230001", to: "27 Havelock Road, Colombo 05", cod: 485_000, grams: 650 },
  { m: GADGETS, name: "Dinesh Arumugam", phone: "+94771230002", to: "8/2 Rosmead Place, Colombo 07", cod: 1_249_900, grams: 420 },
  { m: THREADS, name: "Fathima Rizna", phone: "+94771230003", to: "15 Hill Street, Dehiwala", cod: 0, grams: 900 },
  { m: GADGETS, name: "Kasun Bandara", phone: "+94771230004", to: "102 Pagoda Road, Nugegoda", cod: 689_000, grams: 380 },
  { m: THREADS, name: "Nirmala Thurairajah", phone: "+94771230005", to: "3 Marine Drive, Colombo 03", cod: 320_000, grams: 700 },
  { m: THREADS, name: "Ruwan Senanayake", phone: "+94771230006", to: "56 Kotte Road, Rajagiriya", cod: 0, grams: 1200 },
  { m: GADGETS, name: "Shalini Mahendran", phone: "+94771230007", to: "19 Templers Road, Mount Lavinia", cod: 254_500, grams: 300 },
  { m: THREADS, name: "Prakash Velupillai", phone: "+94771230008", to: "41 Duplication Road, Colombo 04", cod: 562_000, grams: 800 },
  // still at the hub after the run went out
  { m: GADGETS, name: "Ishara Gunasekara", phone: "+94771230009", to: "7 High Level Road, Maharagama", cod: 899_000, grams: 450 },
  { m: THREADS, name: "Mohamed Nazeer", phone: "+94771230010", to: "88 Baseline Road, Colombo 09", cod: 275_000, grams: 600 },
  { m: THREADS, name: "Janani Sritharan", phone: "+94771230011", to: "12 Main Street, Battaramulla", cod: 0, grams: 500 },
  // picked up, on the way to the hub
  { m: GADGETS, name: "Lahiru Wickramasinghe", phone: "+94771230012", to: "64 Negombo Road, Wattala", cod: 1_599_000, grams: 700 },
  { m: THREADS, name: "Keerthi Pillai", phone: "+94771230013", to: "5 Havelock Road, Colombo 05", cod: 410_000, grams: 550 },
  { m: THREADS, name: "Sanduni Perera", phone: "+94771230014", to: "31 Rosmead Place, Colombo 07", cod: 0, grams: 950 },
  // booked this afternoon, waiting for pickup
  { m: THREADS, name: "Arun Ganeshan", phone: "+94771230015", to: "9 Hill Street, Dehiwala", cod: 365_000, grams: 600 },
  { m: GADGETS, name: "Chamari Fernando", phone: "+94771230016", to: "22 Pagoda Road, Nugegoda", cod: 749_000, grams: 350 },
  { m: THREADS, name: "Tharindu Silva", phone: "+94771230017", to: "70 Marine Drive, Colombo 03", cod: 0, grams: 1100 },
  { m: GADGETS, name: "Vithya Kanagaratnam", phone: "+94771230018", to: "14 Kotte Road, Rajagiriya", cod: 1_099_000, grams: 400 },
];
const KANDY: Booking[] = [
  { m: THREADS, name: "Senthuran Arulanandam", phone: "+94771230101", to: "45 Peradeniya Road, Kandy", cod: 515_000, grams: 700 },
  { m: GADGETS, name: "Malathi Sivakumar", phone: "+94771230102", to: "12 Sangaraja Mawatha, Kandy", cod: 1_350_000, grams: 420 },
  { m: THREADS, name: "Nimal Jayawardena", phone: "+94771230103", to: "203 Katugastota Road, Kandy", cod: 0, grams: 900 },
  { m: THREADS, name: "Yamuna Ganeshan", phone: "+94771230104", to: "8 Temple Road, Peradeniya", cod: 298_000, grams: 650 },
  { m: GADGETS, name: "Rajesh Kanagaratnam", phone: "+94771230105", to: "17 William Gopallawa Mawatha, Kandy", cod: 459_000, grams: 380 },
  { m: THREADS, name: "Dilani Bandara", phone: "+94771230106", to: "61 Peradeniya Road, Kandy", cod: 380_000, grams: 750 },
  // at the Kandy hub for tomorrow
  { m: THREADS, name: "Gowtham Pillai", phone: "+94771230107", to: "3 Sangaraja Mawatha, Kandy", cod: 0, grams: 500 },
  { m: GADGETS, name: "Thenmozhi Velupillai", phone: "+94771230108", to: "92 Katugastota Road, Kandy", cod: 699_000, grams: 330 },
];
const IN_TRANSIT: Booking[] = [
  { m: THREADS, name: "Kavya Thurairajah", phone: "+94771230201", to: "28 Peradeniya Road, Kandy", cod: 445_000, grams: 600 },
  { m: GADGETS, name: "Suresh Mahendran", phone: "+94771230202", to: "6 Temple Road, Peradeniya", cod: 0, grams: 400 },
  { m: THREADS, name: "Pradeep Fernando", phone: "+94771230203", to: "140 Katugastota Road, Kandy", cod: 270_000, grams: 850 },
];

async function book(list: Booking[], label: string) {
  const out: { awb: string; b: Booking }[] = [];
  for (const [i, b] of list.entries()) {
    const r = await clientFor(admin.accessToken, key(`book-${label}-${i}`)).parcels.create({
      merchantId: b.m.id,
      branchId: CMB_BRANCH,
      weightGrams: b.grams,
      declaredValueCents: Math.max(b.cod, 250_000),
      codAmountCents: b.cod,
      originAddress: b.m.origin,
      consigneeName: b.name,
      consigneePhone: b.phone,
      destAddress: b.to,
    });
    out.push({ awb: r.parcel.awb, b });
  }
  console.log(`booked ${out.length} (${label})`);
  return out;
}
async function move(awbs: string[], to: "PickedUp" | "AtOriginHub" | "Bagged" | "InTransit" | "AtDestHub", label: string) {
  if (awbs.length === 0) return;
  const r = await clientFor(admin.accessToken, key(`${label}-${to}`)).parcels.transitionMany({ awbs, to, notes: null });
  if (r.rejected.length) throw new Error(`${label} → ${to}: ${JSON.stringify(r.rejected)}`);
}

/** Colombo hub → sealed bag → linehaul trip (→ Kandy receipt when `arrive`). */
async function linehaul(awbs: string[], o: { vehicle: string; route: string; arrive: boolean }) {
  await move(awbs, "PickedUp", o.vehicle);
  await move(awbs, "AtOriginHub", o.vehicle);
  const v = (l: string) => key(`${o.vehicle}-${l}`);
  const bag = await clientFor(cmbVan.accessToken, v("bag")).transport.bagCreate({ destHubId: KDY_HUB });
  const scan = await clientFor(cmbVan.accessToken, v("scan")).transport.bagScan({ bagId: bag.id, awbs });
  if (scan.accepted.length !== awbs.length) throw new Error(`bag scan ${JSON.stringify(scan.rejected)}`);
  const sealNumber = `SL-${String(Date.now()).slice(-6)}`;
  await clientFor(cmbVan.accessToken, v("seal")).transport.bagSeal({ bagId: bag.id, sealNumber });
  const trip = await clientFor(cmbVan.accessToken, v("trip")).transport.tripCreate({
    vehicleRegistration: o.vehicle,
    destHubId: KDY_HUB,
    route: o.route,
  });
  await clientFor(cmbVan.accessToken, v("load")).transport.tripLoad({ tripId: trip.id, bagId: bag.id });
  const dep = await clientFor(cmbVan.accessToken, v("depart")).transport.tripDepart({ tripId: trip.id, seal: `VS-${sealNumber}` });
  if (dep.rejected.length) throw new Error(`depart ${JSON.stringify(dep.rejected)}`);
  if (!o.arrive) return;
  await clientFor(cmbVan.accessToken, v("arrive")).transport.tripArrive({ tripId: trip.id });
  const r = await clientFor(kdyVan.accessToken, v("recv")).transport.bagReceive({
    bagId: bag.id,
    scannedAwbs: awbs,
    sealNumber,
    releasedByName: "Murugan Thevarajah",
    receivedByName: kdyVan.user.name,
  });
  if (r.received.length !== awbs.length || r.exceptionsRaised > 0) throw new Error(`receipt ${r.received.length}/${awbs.length}`);
}

const SIGNATURE =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><path d="M10 70 C 40 10, 60 90, 90 40 S 140 20, 160 60 S 220 80, 240 30 L 290 50" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round"/></svg>',
  ).toString("base64");

async function deliver(rider: { accessToken: string }, p: { awb: string; b: Booking }, lat: number, lng: number) {
  const common = {
    awb: p.awb,
    receivedByName: p.b.name,
    receivedByRelation: "self" as const,
    codCollectedCents: p.b.cod,
    lat,
    lng,
  };
  if (p.b.m.pod === "otp") {
    const ch = await clientFor(rider.accessToken, key(`otp-${p.awb}`)).delivery.otpRequest({ awb: p.awb });
    await clientFor(rider.accessToken, key(`otpv-${p.awb}`)).delivery.otpVerify({ awb: p.awb, code: ch.devCode! });
    await clientFor(rider.accessToken, key(`pod-${p.awb}`)).delivery.recordDelivery({ ...common, method: "otp" });
  } else {
    await clientFor(rider.accessToken, key(`pod-${p.awb}`)).delivery.recordDelivery({ ...common, method: "signature", signatureData: SIGNATURE });
  }
}
async function miss(rider: { accessToken: string }, awb: string, reasonCode: string, notes: string, lat: number, lng: number) {
  const r = await clientFor(rider.accessToken, key(`fail-${awb}`)).delivery.recordFailure({ awb, reasonCode, notes, lat, lng });
  if (!r.ndrId) throw new Error(`${awb}: no NDR raised`);
}
async function runFor(
  ops: { accessToken: string },
  rider: { accessToken: string; user: { id: string } },
  awbs: string[],
  branchId: string,
  label: string,
) {
  for (const open of await clientFor(ops.accessToken).delivery.runsheetList({ riderId: rider.user.id, status: ["draft", "dispatched"] })) {
    throw new Error(`${label}: rider already has run ${open.code} (${open.status}) — run this on a freshly seeded demo DB`);
  }
  await bankRiderCash({ clientFor, login, riderToken: rider.accessToken, branchId, key, label });
  const run = await clientFor(ops.accessToken, key(`${label}-run`)).delivery.runsheetCreate({ riderId: rider.user.id });
  const added = await clientFor(ops.accessToken, key(`${label}-add`)).delivery.runsheetAdd({ runsheetId: run.id, awbs });
  if (added.added !== awbs.length) throw new Error(`${label}: added ${added.added}/${awbs.length} ${JSON.stringify(added.lines)}`);
  await clientFor(ops.accessToken, key(`${label}-opt`)).delivery.runsheetOptimise({ runsheetId: run.id }).catch(() => undefined);
  const out = await clientFor(ops.accessToken, key(`${label}-dispatch`)).delivery.runsheetDispatch({ runsheetId: run.id, notes: null });
  if (out.movedOut.length !== awbs.length) throw new Error(`${label}: dispatched ${out.movedOut.length}/${awbs.length}`);
  console.log(`${label}: ${out.runsheet.code} dispatched with ${awbs.length} stops`);
}

// ── Colombo ──────────────────────────────────────────────────────────────────
const cmb = await book(COLOMBO, "cmb");
const cmbRun = cmb.slice(0, 8);
const cmbAtHub = cmb.slice(8, 11);
const cmbPicked = cmb.slice(11, 14);
await move([...cmbRun, ...cmbAtHub, ...cmbPicked].map((p) => p.awb), "PickedUp", "cmb");
await move([...cmbRun, ...cmbAtHub].map((p) => p.awb), "AtOriginHub", "cmb");
// Colombo-local stops ride no linehaul: they are processed at their own
// branch and stay accountable to it, so no bag/trip rows exist for them
// (a bag's origin and destination must differ). A run only takes AtDestHub
// parcels, so — exactly as the base seed and seed-demo-history stage custody
// — write the legal chain (AtOriginHub → Bagged → InTransit → AtDestHub)
// straight to the ledger and set the status.
{
  const { parcel, parcelEvent } = await import("../src/api/database/schema/parcels");
  const { prefixedId } = await import("../src/api/shared/ulid");
  const rows = await db.select().from(parcel).where(inArray(parcel.awb, cmbRun.map((p) => p.awb)));
  let t = Date.now() - 3_600_000;
  for (const r of rows) {
    for (const [fromStatus, toStatus] of [["AtOriginHub", "Bagged"], ["Bagged", "InTransit"], ["InTransit", "AtDestHub"]] as const) {
      await db.insert(parcelEvent).values({
        id: prefixedId("evt"),
        parcelId: r.id,
        fromStatus,
        toStatus,
        actorId: admin.user.id,
        actorName: admin.user.name,
        actorRole: "admin",
        notes: "local hub processing",
        ts: new Date(t),
      });
      t += 60_000;
    }
    await db.update(parcel).set({ status: "AtDestHub", updatedAt: new Date() }).where(eq(parcel.id, r.id));
  }
  console.log(`cmb-local: ${rows.length} stops walked to AtDestHub`);
}
await runFor(cmbOps, cmbRider, cmbRun.map((p) => p.awb), CMB_BRANCH, "cmb");
await deliver(cmbRider, cmbRun[0]!, 6.8931, 79.8636);
await deliver(cmbRider, cmbRun[1]!, 6.9093, 79.8664);
await deliver(cmbRider, cmbRun[2]!, 6.8512, 79.8712);
await deliver(cmbRider, cmbRun[3]!, 6.8722, 79.8894);
await miss(cmbRider, cmbRun[4]!.awb, "CONSIGNEE_NOT_AT_HOME", "Gate locked, neighbour says back after 6 pm.", 6.9047, 79.8494);
console.log("cmb: 4 delivered, 1 missed, 3 still out");

// ── Kandy (railed in this morning) ───────────────────────────────────────────
const kdy = await book(KANDY, "kdy");
await linehaul(kdy.map((p) => p.awb), { vehicle: "WP LJ-7710", route: "Colombo → Kandy (A1), overnight run", arrive: true });
const kdyRun = kdy.slice(0, 6);
await runFor(kdyOps, kdyRider, kdyRun.map((p) => p.awb), KDY_HUB, "kdy");
await deliver(kdyRider, kdyRun[0]!, 7.2872, 80.6281);
await deliver(kdyRider, kdyRun[1]!, 7.2931, 80.6339);
await deliver(kdyRider, kdyRun[2]!, 7.3126, 80.6244);
await miss(kdyRider, kdyRun[3]!.awb, "CONSIGNEE_UNREACHABLE", "Called three times, phone switched off.", 7.2599, 80.5977);
await miss(kdyRider, kdyRun[4]!.awb, "RESCHEDULE_REQUESTED", "Customer asked for delivery on Tuesday.", 7.278, 80.632);
console.log("kdy: 3 delivered, 2 missed, 1 still out, 2 at hub");

// ── Linehaul: tonight's van, departed ────────────────────────────────────────
const tr = await book(IN_TRANSIT, "transit");
await linehaul(tr.map((p) => p.awb), { vehicle: "WP LK-4821", route: "Colombo → Kandy (A1), evening run", arrive: false });
console.log("linehaul: evening van departed for Kandy");

await db.delete(rateLimit);
console.log(`\ndemo live day seeded: ${cmb.length + kdy.length + tr.length} parcels booked today`);
process.exit(0);
