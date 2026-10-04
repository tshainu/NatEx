/**
 * Demo history — 30 days of finished parcels for the DEMO site's dashboards.
 *
 * The base seed (`bun run db:seed`) builds today's live, in-flight state and
 * `scripts/seed-m4.ts` builds one merchant's money trail. Neither has history,
 * so every throughput chart is a single spike on the last two days. This adds
 * ~350 parcels booked 3–30 days ago, each with a full, legal custody chain
 * (PROJECT.md §6) ending in a terminal state: mostly Delivered (some after a
 * failed attempt), some returned to origin, a few cancelled before pickup.
 *
 * What it is NOT: money. These parcels carry COD amounts so the merchant and
 * company charts show "COD on deliveries", but no COD ledger, deposit or
 * settlement rows are written for them — the finance screens stay exactly as
 * seed-m4 and live use leave them, and the nightly invariant is unaffected
 * (it compares ledger tables only).
 *
 * IDEMPOTENT: it deletes its own parcels (AWB prefix NX71…) and their events
 * first. DEV/DEMO ONLY — refuses NODE_ENV=production.
 *
 *   bun --env-file=<demo env> scripts/seed-demo-history.ts
 */
import { inArray, like } from "drizzle-orm";
import { db } from "../src/api/database";
import { parcel, parcelEvent } from "../src/api/database/schema/parcels";
import type { ParcelStatus } from "../src/api/modules/parcels/state-machine";
import { TRANSITIONS } from "../src/api/modules/parcels/state-machine";
import { isDevelopment } from "../src/api/shared/env";
import { toE6 } from "../src/api/shared/geo";
import { prefixedId } from "../src/api/shared/ulid";

if (!isDevelopment()) {
  throw new Error(`Refusing to write demo history outside NODE_ENV=development/test (got ${process.env.NODE_ENV ?? "unset"}).`);
}

const AWB_PREFIX = "NX71";
const BRANCH_ID = "brn_cmb_central";
const MERCHANTS = [
  { id: "mch_ceylon_threads", origin: "44 Galle Road, Colombo 04", lat: 6.8905, lng: 79.8565, by: "Sanjay Kumar", weight: 3 },
  { id: "mch_lanka_gadgets", origin: "12 Stanley Thilakaratne Mw, Nugegoda", lat: 6.8649, lng: 79.8997, by: "Lanka Gadgets desk", weight: 2 },
];

const FIRST = ["Anitha", "Gowtham", "Nirmala", "Dinesh", "Yamuna", "Rajesh", "Thenmozhi", "Prakash", "Kavya", "Suresh",
  "Malathi", "Arun", "Shalini", "Nimal", "Dilani", "Kasun", "Chamari", "Ruwan", "Ishara", "Tharindu", "Sanduni", "Fathima",
  "Mohamed", "Rizwan", "Nadeesha", "Pradeep", "Vithya", "Keerthi", "Janani", "Lahiru"];
const LAST = ["Kanagaratnam", "Pillai", "Thurairajah", "Ganeshan", "Sritharan", "Mahendran", "Arulanandam", "Velupillai",
  "Perera", "Fernando", "Silva", "Jayawardena", "Wickramasinghe", "Bandara", "Rajapaksha", "Nazeer", "Fareed", "Senanayake",
  "Gunasekara", "Sivakumar"];
const LOCAL: [string, number, number][] = [
  ["Havelock Rd, Colombo 05", 6.8931, 79.8636], ["Rosmead Pl, Colombo 07", 6.9093, 79.8664],
  ["Hill St, Dehiwala", 6.8512, 79.8712], ["Pagoda Rd, Nugegoda", 6.8722, 79.8894],
  ["Marine Dr, Colombo 03", 6.9047, 79.8494], ["Kotte Rd, Rajagiriya", 6.9101, 79.8951],
  ["Templers Rd, Mount Lavinia", 6.8321, 79.8632], ["Duplication Rd, Colombo 04", 6.8887, 79.858],
  ["High Level Rd, Maharagama", 6.8480, 79.9265], ["Baseline Rd, Colombo 09", 6.9290, 79.8720],
  ["Negombo Rd, Wattala", 6.9890, 79.8920], ["Main St, Battaramulla", 6.8990, 79.9180],
];
const UPCOUNTRY: [string, number, number][] = [
  ["Peradeniya Rd, Kandy", 7.2872, 80.6281], ["Sangaraja Mw, Kandy", 7.2931, 80.6339],
  ["Katugastota Rd, Kandy", 7.3126, 80.6244], ["Temple Rd, Peradeniya", 7.2599, 80.5977],
  ["William Gopallawa Mw, Kandy", 7.2780, 80.6320],
];

const OPS_CMB = { actorName: "Priya Shanmugam", actorRole: "ops" };
const OPS_KDY = { actorName: "Lakshmi Nadarajah (Kandy)", actorRole: "ops" };
const RIDER_CMB = { actorName: "Karthik Selvaraj", actorRole: "rider" };
const RIDER_KDY = { actorName: "Senthil Kumaran (Kandy)", actorRole: "rider" };
const VAN = { actorName: "Murugan Thevarajah (Colombo)", actorRole: "transport" };

/** Deterministic PRNG so a re-run builds the same history. */
let seed = 20261004;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

type Step = { status: ParcelStatus; actorName: string; actorRole: string; at: Date };

/** Colombo wall-clock time `daysAgo` days back, at hour h (fractional ok). */
function colomboAt(daysAgo: number, h: number): Date {
  const now = new Date();
  const day = new Date(now.getTime() + 5.5 * 3600_000);
  day.setUTCHours(0, 0, 0, 0);
  return new Date(day.getTime() - daysAgo * 86_400_000 + h * 3600_000 - 5.5 * 3600_000);
}

function chain(daysAgo: number, upcountry: boolean, outcome: "delivered" | "retry" | "rto" | "cancelled", by: string): Step[] {
  const t0 = 8.5 + rand() * 8;
  const s: Step[] = [{ status: "Booked", actorName: by, actorRole: "merchant", at: colomboAt(daysAgo, t0) }];
  if (outcome === "cancelled") {
    s.push({ status: "Cancelled", actorName: by, actorRole: "merchant", at: colomboAt(daysAgo, t0 + 1 + rand() * 3) });
    return s;
  }
  let t = t0 + 2 + rand() * 3;
  s.push({ status: "PickedUp", ...RIDER_CMB, at: colomboAt(daysAgo, t) });
  t += 1 + rand();
  s.push({ status: "AtOriginHub", ...OPS_CMB, at: colomboAt(daysAgo, t) });
  let day = daysAgo - 1;
  const rider = upcountry ? RIDER_KDY : RIDER_CMB;
  if (upcountry) {
    s.push({ status: "Bagged", ...OPS_CMB, at: colomboAt(daysAgo, t + 0.5) });
    s.push({ status: "InTransit", ...VAN, at: colomboAt(daysAgo, Math.max(t + 1, 21)) });
    s.push({ status: "AtDestHub", ...OPS_KDY, at: colomboAt(day, 3.5 + rand()) });
  }
  const attempts = outcome === "delivered" ? 0 : outcome === "retry" ? 1 : 3;
  for (let a = 0; a < attempts; a += 1) {
    s.push({ status: "OutForDelivery", ...rider, at: colomboAt(day, 8.5 + rand()) });
    s.push({ status: "DeliveryAttempted", ...rider, at: colomboAt(day, 11 + rand() * 5) });
    day -= 1;
  }
  if (outcome === "rto") {
    s.push({ status: "RTOInitiated", ...(upcountry ? OPS_KDY : OPS_CMB), at: colomboAt(day + 1, 18) });
    s.push({ status: "RTOInTransit", ...(upcountry ? VAN : RIDER_CMB), at: colomboAt(day, 9 + rand()) });
    s.push({ status: "RTODelivered", ...RIDER_CMB, at: colomboAt(day, 14 + rand() * 3) });
    return s;
  }
  s.push({ status: "OutForDelivery", ...rider, at: colomboAt(day, 8.5 + rand()) });
  s.push({ status: "Delivered", ...rider, at: colomboAt(day, 10 + rand() * 7) });
  return s;
}

// Guard: every generated chain must be legal under the §6 transition table.
function assertLegal(steps: Step[]) {
  for (let i = 1; i < steps.length; i += 1) {
    const from = steps[i - 1]!.status;
    const to = steps[i]!.status;
    if (!TRANSITIONS[from].includes(to)) throw new Error(`illegal ${from} → ${to}`);
    if (steps[i]!.at < steps[i - 1]!.at) throw new Error(`time runs backwards at ${from} → ${to}`);
  }
}

// ── wipe our own rows ──────────────────────────────────────────────────────
const old = await db.select({ id: parcel.id }).from(parcel).where(like(parcel.awb, `${AWB_PREFIX}%`));
for (let i = 0; i < old.length; i += 200) {
  const ids = old.slice(i, i + 200).map((r) => r.id);
  await db.delete(parcelEvent).where(inArray(parcelEvent.parcelId, ids));
  await db.delete(parcel).where(inArray(parcel.id, ids));
}
console.log(`removed ${old.length} earlier demo-history parcels`);

// ── build ──────────────────────────────────────────────────────────────────
const parcels: (typeof parcel.$inferInsert)[] = [];
const events: (typeof parcelEvent.$inferInsert)[] = [];
const counts: Record<string, number> = {};
let n = 0;
const weighted = MERCHANTS.flatMap((m) => Array<typeof m>(m.weight).fill(m));

for (let daysAgo = 30; daysAgo >= 3; daysAgo -= 1) {
  const weekday = colomboAt(daysAgo, 12).getUTCDay();
  const base = weekday === 0 ? 5 : weekday === 6 ? 9 : 12;
  // A gentle upward trend over the month, plus noise.
  const volume = Math.round(base + (30 - daysAgo) * 0.25 + rand() * 4);
  for (let k = 0; k < volume; k += 1) {
    const m = pick(weighted);
    const upcountry = rand() < 0.22;
    const r = rand();
    let outcome: "delivered" | "retry" | "rto" | "cancelled" =
      r < 0.04 ? "cancelled" : r < 0.11 ? "rto" : r < 0.24 ? "retry" : "delivered";
    // Every step must be in the past: an RTO needs 4 more days, a retry 2.
    if (outcome === "rto" && daysAgo < 5) outcome = "retry";
    const steps = chain(daysAgo, upcountry, outcome, m.by);
    assertLegal(steps);
    const [street, lat, lng] = pick(upcountry ? UPCOUNTRY : LOCAL);
    const id = prefixedId("pcl");
    const prepaid = rand() < 0.3;
    const last = steps[steps.length - 1]!;
    parcels.push({
      id,
      awb: `${AWB_PREFIX}${String(10000000 + n * 7919).slice(-8)}`,
      merchantId: m.id,
      branchId: BRANCH_ID,
      status: last.status,
      weightGrams: 300 + Math.floor(rand() * 4500),
      lengthCm: 18 + Math.floor(rand() * 20),
      widthCm: 12 + Math.floor(rand() * 12),
      heightCm: 5 + Math.floor(rand() * 12),
      declaredValueCents: (1500 + Math.floor(rand() * 15000)) * 100,
      codAmountCents: prepaid ? 0 : (990 + Math.floor(rand() * 9000)) * 100,
      originAddress: m.origin,
      originLat: toE6(m.lat),
      originLng: toE6(m.lng),
      consigneeName: `${pick(FIRST)} ${pick(LAST)}`,
      consigneePhone: `+9476${String(3000000 + n).padStart(7, "0")}`,
      destAddress: `${1 + Math.floor(rand() * 240)} ${street}`,
      destLat: toE6(lat + (rand() - 0.5) * 0.01),
      destLng: toE6(lng + (rand() - 0.5) * 0.01),
      destZoneId: null,
      deliveryAttempts: steps.filter((s) => s.status === "DeliveryAttempted").length,
      createdAt: steps[0]!.at,
      updatedAt: last.at,
    });
    let prev: ParcelStatus | null = null;
    for (const s of steps) {
      events.push({ id: prefixedId("pev"), parcelId: id, fromStatus: prev, toStatus: s.status, actorName: s.actorName, actorRole: s.actorRole, ts: s.at });
      prev = s.status;
    }
    counts[last.status] = (counts[last.status] ?? 0) + 1;
    n += 1;
  }
}

for (let i = 0; i < parcels.length; i += 100) await db.insert(parcel).values(parcels.slice(i, i + 100));
for (let i = 0; i < events.length; i += 200) await db.insert(parcelEvent).values(events.slice(i, i + 200));
console.log(JSON.stringify({ parcels: parcels.length, events: events.length, finalStates: counts }, null, 2));
process.exit(0);
