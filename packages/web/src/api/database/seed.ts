/**
 * Seed script — PROJECT.md §10 M1: "1 branch, 3 users, 2 merchants, 20 parcels,
 * 5 zones", plus enough manifests that the collection flow is demonstrable with
 * real data (§12: "the feature is demonstrable with real data").
 *
 * Run: bun run db:seed   (from repo root, or packages/web)
 *
 * Deliberately destructive and dev-only: it clears the tables it owns and
 * rebuilds them, so the demo state is reproducible. It refuses to run with
 * NODE_ENV=production.
 *
 * Extra users beyond the three §10 asks for: this build ships all four web
 * portals, so a finance user and a merchant-portal user are seeded too, plus a
 * second transport user and a rider at the destination hub so M2's linehaul and
 * M3's delivery run are demonstrable end to end. Noted in the README rather
 * than silently added.
 */
import { db } from "./__client";
import { branch, mfaFactor, mfaRecoveryCode, otpChallenge, refreshToken, user } from "./schema/identity";
import { merchant, rateBand, rateCard, rateCardVersion, rateSlab, rateSurcharge } from "./schema/merchants";
import { settingValue } from "./schema/settings";
import { awbBatch, awbBatchLabel, awbBatchSeries, parcel, parcelEvent } from "./schema/parcels";
import { manifest, manifestItem } from "./schema/collection";
import { geocodeCache, zone } from "./schema/routing";
import { bag, bagItem, custodyException, hubScan, trip } from "./schema/transport";
import {
  deliveryAttempt,
  deliveryOtp,
  deliveryPod,
  ndr,
  reasonCode,
  rto,
  runsheet,
  runsheetItem,
} from "./schema/delivery";
import { notifyMessage, notifyTemplate } from "./schema/notifications";
import { auditLog, idempotencyKey, outbox, rateLimit, smsLog } from "./schema/shared";
import { toE6 } from "../shared/geo";
import { hashSecret, type Principal } from "../shared/auth";
import { prefixedId } from "../shared/ulid";
import { seedParcel } from "../modules/parcels/service";
import { seedManifest } from "../modules/collection/service";
import { seedReasonCodes } from "../modules/delivery/reasons";
import { seedTemplates } from "../modules/notifications/service";
import { seedPlaceholderRateCard } from "../modules/merchants/rate-cards";
import { seedDevMfaFactors } from "../modules/identity/mfa";
import * as transport from "../modules/transport/service";
import { colomboToday } from "../modules/collection/service";
import type { ParcelStatus } from "../modules/parcels/state-machine";
import { isDevelopment } from "../shared/env";

if (!isDevelopment()) {
  throw new Error(`Refusing to run the destructive seed outside NODE_ENV=development/test (got ${process.env.NODE_ENV ?? "unset"}).`);
}

const BRANCH_ID = "brn_cmb_central";
const HUB_ID = "brn_cmb_hub";
/** Milestone 2's linehaul destination: the upcountry hub 115 km away. */
const KANDY_HUB_ID = "brn_kdy_hub";
const M1_ID = "mch_ceylon_threads";
const M2_ID = "mch_lanka_gadgets";

const RIDER_ID = "usr_rider_pradeep";
const OPS_ID = "usr_ops_nimali";
const ADMIN_ID = "usr_admin_rajitha";
/** Dev password for every seeded username/password login (see README logins). */
const SEED_PASSWORD = "natex123";
const FINANCE_ID = "usr_finance_dilani";
const MERCHANT_USER_ID = "usr_merchant_sanjay";
const TRANSPORT_ID = "usr_transport_suresh";
const KANDY_TRANSPORT_ID = "usr_transport_chamara";
/**
 * M3's delivery rider. He sits at the *destination* hub, because that is where
 * parcels arrive and where a runsheet is built — Colombo's rider (Karthik) does
 * first-mile pickup, and branch scoping means he cannot deliver Kandy's stops.
 */
const KANDY_RIDER_ID = "usr_rider_kandy";
const KANDY_OPS_ID = "usr_ops_kandy";

const today = colomboToday();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

async function clear() {
  // Order matters only for readability; SQLite FK enforcement is off by default
  // on Turso HTTP, and every table here is seed-owned.
  //
  // Except the outbox, which goes FIRST and deliberately so. The dev server's
  // worker keeps draining while a reseed runs, so any job left pending from the
  // previous run will happily claim itself halfway through this wipe and fail
  // against half-deleted reference data — e.g. "Template parcel.rto_delivered
  // not found", which is the wipe racing the drain, not a broken template.
  // Draining the queue before its data disappears keeps the log honest.
  await db.delete(outbox);
  await db.delete(deliveryPod);
  await db.delete(deliveryAttempt);
  await db.delete(deliveryOtp);
  await db.delete(runsheetItem);
  await db.delete(runsheet);
  await db.delete(rto);
  await db.delete(ndr);
  await db.delete(reasonCode);
  await db.delete(notifyMessage);
  await db.delete(notifyTemplate);
  await db.delete(hubScan);
  await db.delete(custodyException);
  await db.delete(bagItem);
  await db.delete(bag);
  await db.delete(trip);
  await db.delete(manifestItem);
  await db.delete(manifest);
  await db.delete(awbBatchSeries);
  await db.delete(awbBatchLabel);
  await db.delete(awbBatch);
  await db.delete(parcelEvent);
  await db.delete(parcel);
  await db.delete(merchant);
  // M5 rate cards: children before parents, after the merchants that point at them.
  await db.delete(rateSurcharge);
  await db.delete(rateSlab);
  await db.delete(rateBand);
  await db.delete(rateCardVersion);
  await db.delete(rateCard);
  await db.delete(settingValue);
  await db.delete(refreshToken);
  await db.delete(otpChallenge);
  // M5 MFA rows reference identity_user: they go before the users.
  await db.delete(mfaRecoveryCode);
  await db.delete(mfaFactor);
  await db.delete(user);
  await db.delete(branch);
  await db.delete(zone);
  await db.delete(geocodeCache);
  await db.delete(idempotencyKey);
  await db.delete(auditLog);
  await db.delete(rateLimit);
  await db.delete(smsLog);
}

async function seedBranches() {
  await db.insert(branch).values([
    {
      id: BRANCH_ID,
      code: "CMB01",
      name: "Colombo Central",
      address: "128 Union Place, Colombo 02",
      lat: toE6(6.9165),
      lng: toE6(79.8614),
      type: "branch",
    },
    {
      // A second location so nearest-branch has something to choose between.
      id: HUB_ID,
      code: "CMBHUB",
      name: "Colombo Main Hub — Peliyagoda",
      address: "Hub Access Rd, Peliyagoda",
      lat: toE6(6.9686),
      lng: toE6(79.8912),
      type: "hub",
    },
    {
      // Milestone 2 needs a destination hub a linehaul actually runs to, far
      // enough that the leg is overnight rather than a van shuttle.
      id: KANDY_HUB_ID,
      code: "KDYHUB",
      name: "Kandy Regional Hub",
      address: "Katugastota Rd, Kandy",
      lat: toE6(7.3018),
      lng: toE6(80.6297),
      type: "hub",
    },
  ]);
}

async function seedUsers() {
  const SEED_PASSWORD_HASH = await hashSecret(SEED_PASSWORD);
  const rows = await db.insert(user).values([
    {
      id: RIDER_ID,
      branchId: BRANCH_ID,
      role: "rider",
      name: "Karthik Selvaraj",
      phone: "+94771234567",
      username: "karthik",
      passwordHash: SEED_PASSWORD_HASH,
      deviceId: null,
      status: "active",
    },
    {
      id: OPS_ID,
      branchId: BRANCH_ID,
      role: "ops",
      name: "Priya Shanmugam",
      phone: "+94772345678",
      username: "priya",
      passwordHash: SEED_PASSWORD_HASH,
      status: "active",
    },
    {
      id: ADMIN_ID,
      branchId: BRANCH_ID,
      role: "admin",
      name: "Arjun Rajendran",
      phone: "+94773456789",
      username: "arjun",
      passwordHash: SEED_PASSWORD_HASH,
      status: "active",
    },
    {
      id: FINANCE_ID,
      branchId: BRANCH_ID,
      role: "finance",
      name: "Kavitha Sivakumar",
      phone: "+94774567890",
      username: "kavitha",
      passwordHash: SEED_PASSWORD_HASH,
      status: "active",
    },
    {
      id: TRANSPORT_ID,
      branchId: BRANCH_ID,
      role: "transport",
      name: "Murugan Thevarajah",
      phone: "+94776789012",
      username: "murugan",
      passwordHash: SEED_PASSWORD_HASH,
      status: "active",
    },
    {
      // Sits at the *destination* hub: receiving is his, and the branch-scoping
      // rules mean he cannot seal or depart Colombo's bags.
      id: KANDY_TRANSPORT_ID,
      branchId: KANDY_HUB_ID,
      role: "transport",
      name: "Vignesh Balasubramaniam",
      phone: "+94777890123",
      username: "vignesh",
      passwordHash: SEED_PASSWORD_HASH,
      status: "active",
    },
    {
      // Kandy's own hub staff. Only admin and finance are global scope (§5), so
      // Colombo's ops user genuinely cannot work Kandy's delivery day: someone
      // has to be on the ground there to build runs, answer NDRs and close cash.
      id: KANDY_OPS_ID,
      branchId: KANDY_HUB_ID,
      role: "ops",
      name: "Lakshmi Nadarajah",
      phone: "+94779012345",
      username: "lakshmi",
      passwordHash: SEED_PASSWORD_HASH,
      status: "active",
    },
    {
      id: KANDY_RIDER_ID,
      branchId: KANDY_HUB_ID,
      role: "rider",
      name: "Senthil Kumaran",
      phone: "+94778901234",
      username: "senthil",
      passwordHash: SEED_PASSWORD_HASH,
      deviceId: null,
      status: "active",
    },
    {
      id: MERCHANT_USER_ID,
      branchId: BRANCH_ID,
      role: "merchant",
      name: "Sanjay Kumar",
      phone: "+94775678901",
      username: "sanjay",
      passwordHash: SEED_PASSWORD_HASH,
      merchantId: M1_ID,
      status: "active",
    },
  ].map((row) => ({ ...row, roles: JSON.stringify([row.role]) })));
  return rows;
}

async function seedMerchants() {
  await db.insert(merchant).values([
    {
      id: M1_ID,
      branchId: BRANCH_ID,
      name: "Ceylon Threads (Pvt) Ltd",
      vatNo: "VAT-114203391-7000",
      address: "44 Galle Road, Colombo 04",
      lat: toE6(6.8905),
      lng: toE6(79.8565),
      contactName: "Sanjay Kumar",
      contactPhone: "+94112556677",
      codEnabled: true,
      podPolicy: "signature",
      status: "active",
    },
    {
      id: M2_ID,
      branchId: BRANCH_ID,
      name: "Lanka Gadgets Online",
      vatNo: "VAT-118872014-7000",
      address: "12 Stanley Thilakaratne Mw, Nugegoda",
      lat: toE6(6.8649),
      lng: toE6(79.8997),
      contactName: "Ayesha Wickramasinghe",
      contactPhone: "+94112884455",
      codEnabled: true,
      podPolicy: "otp",
      status: "active",
    },
  ]);
}

/**
 * Five zones as axis-aligned boxes over the Colombo pilot area. Zone 5
 * (Negombo) is deliberately marked not serviceable so the serviceability check
 * has a negative case to return.
 */
async function seedZones() {
  const zones = [
    { name: "Colombo 01-05", minLat: 6.88, minLng: 79.83, maxLat: 6.95, maxLng: 79.89 },
    { name: "Colombo 06-10", minLat: 6.85, minLng: 79.85, maxLat: 6.92, maxLng: 79.92 },
    { name: "Dehiwala — Mount Lavinia", minLat: 6.81, minLng: 79.85, maxLat: 6.87, maxLng: 79.9 },
    { name: "Sri Jayawardenepura Kotte", minLat: 6.88, minLng: 79.89, maxLat: 6.94, maxLng: 79.95 },
  ];

  await db.insert(zone).values([
    ...zones.map((z) => ({
      id: prefixedId("zon"),
      name: z.name,
      branchId: BRANCH_ID,
      minLat: toE6(z.minLat),
      minLng: toE6(z.minLng),
      maxLat: toE6(z.maxLat),
      maxLng: toE6(z.maxLng),
      ring: null,
      serviceable: true,
    })),
    {
      id: prefixedId("zon"),
      name: "Negombo (not yet serviced)",
      branchId: HUB_ID,
      minLat: toE6(7.15),
      minLng: toE6(79.81),
      maxLat: toE6(7.26),
      maxLng: toE6(79.9),
      // A polygon ring, so the ray-casting path (the ST_Contains stand-in) is
      // exercised by the seed data and not only by the bbox path.
      ring: JSON.stringify([
        [toE6(7.15), toE6(79.81)],
        [toE6(7.26), toE6(79.83)],
        [toE6(7.24), toE6(79.9)],
        [toE6(7.16), toE6(79.87)],
      ]),
      serviceable: false,
    },
  ]);
}

interface SeededParcel {
  id: string;
  awb: string;
  status: ParcelStatus;
  merchantId: string;
  upcountry: boolean;
}

interface ParcelSpec {
  merchantId: string;
  status: ParcelStatus;
  consigneeName: string;
  consigneePhone: string;
  destAddress: string;
  destLat: number;
  destLng: number;
  weightGrams: number;
  codRupees: number;
  declaredRupees: number;
  /** Kandy-bound: the linehaul fixtures in seedTransport() use these. */
  upcountry?: boolean;
}

const CONSIGNEES: [string, string, string, number, number][] = [
  ["Anitha Kanagaratnam", "+94761110001", "18 Havelock Rd, Colombo 05", 6.8931, 79.8636],
  ["Gowtham Pillai", "+94761110002", "7 Rosmead Pl, Colombo 07", 6.9093, 79.8664],
  ["Nirmala Thurairajah", "+94761110003", "92 Hill St, Dehiwala", 6.8512, 79.8712],
  ["Dinesh Ganeshan", "+94761110004", "3/1 Pagoda Rd, Nugegoda", 6.8722, 79.8894],
  ["Yamuna Sritharan", "+94761110005", "55 Marine Dr, Colombo 03", 6.9047, 79.8494],
  ["Rajesh Mahendran", "+94761110006", "210 Kotte Rd, Rajagiriya", 6.9101, 79.8951],
  ["Thenmozhi Arulanandam", "+94761110007", "14 Templers Rd, Mount Lavinia", 6.8321, 79.8632],
  ["Prakash Velupillai", "+94761110008", "68 Duplication Rd, Colombo 04", 6.8887, 79.858],
  ["Sangeetha Kandiah", "+94761110009", "9 Ward Pl, Colombo 08", 6.9138, 79.8721],
  ["Mohan Sivapalan", "+94761110010", "31 Old Kesbewa Rd, Boralesgamuwa", 6.8411, 79.9033],
  ["Shanthi Ramanathan", "+94761110011", "120 High Level Rd, Maharagama", 6.8477, 79.9271],
  ["Bala Kumaraswamy", "+94761110012", "5 Flower Rd, Colombo 07", 6.9106, 79.8615],
  ["Revathi Ponnambalam", "+94761110013", "77 Galle Rd, Wellawatte", 6.8748, 79.8592],
  ["Kannan Jeyakumar", "+94761110014", "22 Parliament Rd, Kotte", 6.8924, 79.9036],
  ["Divya Paramanathan", "+94761110015", "40 Baseline Rd, Colombo 09", 6.9327, 79.8781],
  ["Sathish Yogarajah", "+94761110016", "6 Station Rd, Kalubowila", 6.8589, 79.8756],
  ["Malathi Navaratnam", "+94761110017", "88 Nawala Rd, Nawala", 6.8961, 79.8918],
  ["Ganesh Sabaratnam", "+94761110018", "17 Sea Ave, Colombo 03", 6.9153, 79.8477],
  ["Vasanthi Loganathan", "+94761110019", "2 Bauddhaloka Mw, Colombo 04", 6.8963, 79.8641],
  ["Siva Thillainathan", "+94761110020", "150 Kandy Rd, Kiribathgoda", 6.9791, 79.9284],
];

/**
 * Kandy-bound consignees. These exist so the linehaul has a real reason to run:
 * ten parcels sitting at Colombo waiting for the overnight leg upcountry.
 */
const UPCOUNTRY_CONSIGNEES: [string, string, string, number, number][] = [
  ["Ramesh Ratnasingam", "+94762220001", "31 Peradeniya Rd, Kandy", 7.2872, 80.6281],
  ["Kalaivani Subramaniam", "+94762220002", "8 Sangaraja Mw, Kandy", 7.2931, 80.6339],
  ["Hari Krishnan", "+94762220003", "142 Katugastota Rd, Kandy", 7.3126, 80.6244],
  ["Abirami Selvanayagam", "+94762220004", "6 Temple Rd, Peradeniya", 7.2599, 80.5977],
  ["Naveen Thambiah", "+94762220005", "77 Kandy Rd, Katugastota", 7.3341, 80.6178],
  ["Pavithra Murugesu", "+94762220006", "19 Rajapihilla Mw, Kandy", 7.2846, 80.6412],
  ["Aravind Sinnathamby", "+94762220007", "204 Colombo St, Kandy", 7.2905, 80.6301],
  ["Janani Kathirgamanathan", "+94762220008", "45 Hantana Rd, Kandy", 7.2761, 80.6188],
  ["Ilango Manoharan", "+94762220009", "11 Bahirawakanda Rd, Kandy", 7.2958, 80.6244],
  ["Keerthana Rasiah", "+94762220010", "88 Digana Rd, Kundasale", 7.2824, 80.6892],
];

/**
 * Twenty parcels spread across the M1 states so every screen has real data:
 *   6 Booked        → the rider's pickups for today
 *   5 PickedUp      → in the rider's custody, not yet at the hub
 *   6 AtOriginHub   → received, waiting for M2's bagging
 *   2 OnHold        → the exception case
 *   1 Cancelled     → a terminal state, to prove terminal is immutable
 *
 * Plus ten Kandy-bound parcels at AtOriginHub, which M2's linehaul consumes.
 */
function parcelPlan(): ParcelSpec[] {
  const statuses: ParcelStatus[] = [
    ...Array<ParcelStatus>(6).fill("Booked"),
    ...Array<ParcelStatus>(5).fill("PickedUp"),
    ...Array<ParcelStatus>(6).fill("AtOriginHub"),
    ...Array<ParcelStatus>(2).fill("OnHold"),
    "Cancelled",
  ];

  const local: ParcelSpec[] = CONSIGNEES.map(([name, phone, address, lat, lng], i) => ({
    merchantId: i % 3 === 2 ? M2_ID : M1_ID,
    status: statuses[i]!,
    consigneeName: name,
    consigneePhone: phone,
    destAddress: address,
    destLat: lat,
    destLng: lng,
    weightGrams: 350 + ((i * 617) % 4200),
    // Every third parcel is prepaid (COD 0) so the board is not uniform.
    codRupees: i % 3 === 0 ? 0 : 1250 + ((i * 445) % 8750),
    declaredRupees: 1800 + ((i * 733) % 14000),
  }));

  const upcountry: ParcelSpec[] = UPCOUNTRY_CONSIGNEES.map(
    ([name, phone, address, lat, lng], i) => ({
      merchantId: i % 2 === 0 ? M1_ID : M2_ID,
      status: "AtOriginHub" as ParcelStatus,
      consigneeName: name,
      consigneePhone: phone,
      destAddress: address,
      destLat: lat,
      destLng: lng,
      weightGrams: 600 + ((i * 911) % 5200),
      codRupees: i % 4 === 0 ? 0 : 2400 + ((i * 553) % 11000),
      declaredRupees: 3200 + ((i * 877) % 16000),
      upcountry: true,
    }),
  );

  return [...local, ...upcountry];
}

/** The custody chain that lands a parcel in a given state. */
function chainFor(status: ParcelStatus, index: number) {
  const base = 40 - index;
  const booked = {
    status: "Booked" as ParcelStatus,
    actorName: "Sanjay Kumar",
    actorRole: "merchant",
    at: hoursAgo(base),
  };
  const pickedUp = {
    status: "PickedUp" as ParcelStatus,
    actorName: "Karthik Selvaraj",
    actorRole: "rider",
    at: hoursAgo(base - 6),
  };
  const atHub = {
    status: "AtOriginHub" as ParcelStatus,
    actorName: "Priya Shanmugam",
    actorRole: "ops",
    at: hoursAgo(base - 9),
  };

  switch (status) {
    case "Booked":
      return [booked];
    case "PickedUp":
      return [booked, pickedUp];
    case "AtOriginHub":
      return [booked, pickedUp, atHub];
    case "OnHold":
      return [
        booked,
        pickedUp,
        {
          status: "OnHold" as ParcelStatus,
          actorName: "Priya Shanmugam",
          actorRole: "ops",
          at: hoursAgo(base - 8),
        },
      ];
    case "Cancelled":
      return [
        booked,
        {
          status: "Cancelled" as ParcelStatus,
          actorName: "Sanjay Kumar",
          actorRole: "merchant",
          at: hoursAgo(base - 2),
        },
      ];
    default:
      return [booked];
  }
}

async function seedParcels() {
  const plan = parcelPlan();
  const created: SeededParcel[] = [];

  for (let i = 0; i < plan.length; i++) {
    const spec = plan[i]!;
    const awb = `NX${(4820000000 + i * 137).toString()}`;
    const row = await seedParcel(
      {
        awb,
        status: spec.status,
        merchantId: spec.merchantId,
        branchId: BRANCH_ID,
        weightGrams: spec.weightGrams,
        lengthCm: 20 + (i % 5) * 4,
        widthCm: 15 + (i % 3) * 3,
        heightCm: 8 + (i % 4) * 2,
        // MONEY: rupees × 100, stored as integer cents (§9/§11).
        declaredValueCents: spec.declaredRupees * 100,
        codAmountCents: spec.codRupees * 100,
        originAddress:
          spec.merchantId === M1_ID
            ? "44 Galle Road, Colombo 04"
            : "12 Stanley Thilakaratne Mw, Nugegoda",
        originLat: toE6(spec.merchantId === M1_ID ? 6.8905 : 6.8649),
        originLng: toE6(spec.merchantId === M1_ID ? 79.8565 : 79.8997),
        consigneeName: spec.consigneeName,
        consigneePhone: spec.consigneePhone,
        destAddress: spec.destAddress,
        destLat: toE6(spec.destLat),
        destLng: toE6(spec.destLng),
        destZoneId: null,
      },
      chainFor(spec.status, i),
    );
    created.push({
      id: row.id,
      awb: row.awb,
      status: spec.status,
      merchantId: spec.merchantId,
      upcountry: spec.upcountry === true,
    });
  }
  return created;
}

async function seedManifests(parcels: SeededParcel[]) {
  // Today's open pickup: the six Booked parcels, none scanned yet. This is what
  // the rider app opens on, and the parcels it will move to PickedUp live.
  const booked = parcels.filter((p) => p.status === "Booked");
  const bookedM1 = booked.filter((p) => p.merchantId === M1_ID);
  const bookedM2 = booked.filter((p) => p.merchantId === M2_ID);

  if (bookedM1.length) {
    await seedManifest({
      id: "mfs_today_ceylon_threads",
      code: `MF${today.replaceAll("-", "").slice(2)}-1001`,
      merchantId: M1_ID,
      branchId: BRANCH_ID,
      riderId: RIDER_ID,
      pickupDate: today,
      status: "assigned",
      items: bookedM1.map((p) => ({ parcelId: p.id, awb: p.awb, scannedAt: null })),
    });
  }

  if (bookedM2.length) {
    await seedManifest({
      id: "mfs_today_lanka_gadgets",
      code: `MF${today.replaceAll("-", "").slice(2)}-1002`,
      merchantId: M2_ID,
      branchId: BRANCH_ID,
      riderId: RIDER_ID,
      pickupDate: today,
      status: "assigned",
      items: bookedM2.map((p) => ({ parcelId: p.id, awb: p.awb, scannedAt: null })),
    });
  }

  // A completed pickup from earlier, so the manifest list has a closed example.
  const collected = parcels
    .filter((p) => p.status === "PickedUp" || p.status === "AtOriginHub")
    .slice(0, 5);
  if (collected.length) {
    await seedManifest({
      id: "mfs_yesterday_done",
      code: `MF${today.replaceAll("-", "").slice(2)}-0907`,
      merchantId: M1_ID,
      branchId: BRANCH_ID,
      riderId: RIDER_ID,
      pickupDate: today,
      status: "handed_over",
      items: collected.map((p) => ({
        parcelId: p.id,
        awb: p.awb,
        scannedAt: hoursAgo(30),
      })),
    });
  }
}

async function seedGeocodes() {
  await db.insert(geocodeCache).values([
    {
      addressKey: "44-galle-road-colombo-04",
      address: "44 Galle Road, Colombo 04",
      lat: toE6(6.8905),
      lng: toE6(79.8565),
      provider: "seed",
    },
    {
      addressKey: "12-stanley-thilakaratne-mw-nugegoda",
      address: "12 Stanley Thilakaratne Mw, Nugegoda",
      lat: toE6(6.8649),
      lng: toE6(79.8997),
      provider: "seed",
    },
  ]);
}

/**
 * Milestone 2 fixtures, built by calling the transport service rather than
 * inserting rows: every bag, seal, trip and receipt therefore carries the same
 * events, scan log lines and exceptions a real hub would have produced. A
 * hand-written row would look right on screen and be a lie in the timeline.
 *
 * Three bags, deliberately in three different places:
 *   BAG 1  open at Colombo, three parcels in  → the bagging screen
 *   BAG 2  sealed, departed, arrived Kandy     → the inbound queue, unreceived
 *   BAG 3  sealed, departed, arrived, received with one parcel short
 *          → a `missing_at_destination` exception open in the Ops queue
 */
async function seedTransport(parcels: SeededParcel[]) {
  const cmb: Principal = {
    userId: TRANSPORT_ID,
    name: "Murugan Thevarajah",
    role: "transport",
    roles: ["transport"],
    branchId: BRANCH_ID,
    deviceId: "seed-hub-scanner-cmb",
  };
  const kdy: Principal = {
    userId: KANDY_TRANSPORT_ID,
    name: "Vignesh Balasubramaniam",
    role: "transport",
    roles: ["transport"],
    branchId: KANDY_HUB_ID,
    deviceId: "seed-hub-scanner-kdy",
  };

  const upcountry = parcels.filter((p) => p.upcountry).map((p) => p.awb);
  const forBag1 = upcountry.slice(0, 3);
  const forBag2 = upcountry.slice(3, 6);
  const forBag3 = upcountry.slice(6, 10);

  // ── BAG 1: still open on the bagging bench.
  const bag1 = await transport.createBag({ destHubId: KANDY_HUB_ID }, cmb);
  await transport.bulkScanIntoBag({ bagId: bag1.id, awbs: forBag1 }, cmb);

  // ── BAG 2: sealed, loaded, departed, arrived — waiting to be scanned in.
  const bag2 = await transport.createBag({ destHubId: KANDY_HUB_ID }, cmb);
  await transport.bulkScanIntoBag({ bagId: bag2.id, awbs: forBag2 }, cmb);
  await transport.sealBag({ bagId: bag2.id, sealNumber: "SL-884201" }, cmb);

  // ── BAG 3: same journey, one leg further — received, and short a parcel.
  const bag3 = await transport.createBag({ destHubId: KANDY_HUB_ID }, cmb);
  await transport.bulkScanIntoBag({ bagId: bag3.id, awbs: forBag3 }, cmb);
  await transport.sealBag({ bagId: bag3.id, sealNumber: "SL-884202" }, cmb);

  // One overnight trip carries both sealed bags up the A1.
  const tripRow = await transport.createTrip(
    {
      vehicleRegistration: "LJ-4471",
      destHubId: KANDY_HUB_ID,
      route: "Colombo → Kandy (A1, overnight)",
      driverId: null,
    },
    cmb,
  );
  await transport.loadBagOntoTrip({ tripId: tripRow.id, bagId: bag2.id }, cmb);
  await transport.loadBagOntoTrip({ tripId: tripRow.id, bagId: bag3.id }, cmb);
  await transport.departTrip({ tripId: tripRow.id, seal: "VEH-99120" }, cmb);
  await transport.arriveTrip({ tripId: tripRow.id }, kdy);

  // Kandy scans bag 3 in and is one parcel short of the manifest. The receipt
  // records what was actually in the bag; the gap becomes an exception, which
  // is the whole point of §7 — the variance is never reconciled away.
  const short = forBag3.slice(0, forBag3.length - 1);
  const receipt = await transport.receiveBag(
    {
      bagId: bag3.id,
      scannedAwbs: short,
      sealNumber: "SL-884202",
      releasedByName: "Murugan Thevarajah",
      receivedByName: "Vignesh Balasubramaniam",
    },
    kdy,
  );

  return {
    bags: 3,
    trips: 1,
    bagged: forBag1.length,
    inTransit: forBag2.length,
    receivedAtKandy: receipt.received.length,
    missingAtKandy: receipt.missing.length,
    openExceptions: receipt.exceptionsRaised,
  };
}

export async function seed() {
  await clear();
  await seedBranches();
  await seedUsers();
  await seedMerchants();
  await seedZones();
  await seedGeocodes();
  // Reference data the delivery module reads on every doorstep scan (§10 M3):
  // failure reason codes and the message templates the notifier renders.
  const reasonCodes = await seedReasonCodes();
  const templates = await seedTemplates();
  const parcels = await seedParcels();
  await seedManifests(parcels);
  const custody = await seedTransport(parcels);
  // M5: the PLACEHOLDER rate card (§15 q3 is open — not client-approved
  // pricing) and the development-only TOTP factors for the seeded ops, admin
  // and finance users (identity/mfa.ts; refused in production).
  const rateCards = await seedPlaceholderRateCard();
  const mfa = await seedDevMfaFactors();

  const summary = {
    branches: 3,
    users: 8,
    merchants: 2,
    parcels: parcels.length,
    zones: 5,
    manifests: 3,
    reasonCodes,
    templates,
    custody,
    rateCards,
    mfaSeeded: mfa.seeded.length,
    logins: [
      { role: "rider", phone: "+94771234567", username: "karthik", name: "Karthik Selvaraj" },
      { role: "ops", phone: "+94772345678", name: "Priya Shanmugam" },
      { role: "admin", phone: "+94773456789", name: "Arjun Rajendran" },
      { role: "finance", phone: "+94774567890", name: "Kavitha Sivakumar" },
      { role: "transport", phone: "+94776789012", name: "Murugan Thevarajah (Colombo)" },
      { role: "transport", phone: "+94777890123", name: "Vignesh Balasubramaniam (Kandy)" },
      { role: "rider", phone: "+94778901234", name: "Senthil Kumaran (Kandy)" },
      { role: "ops", phone: "+94779012345", name: "Lakshmi Nadarajah (Kandy)" },
      { role: "merchant", phone: "+94775678901", name: "Sanjay Kumar" },
    ],
  };
  return summary;
}

// `bun run db:seed` executes this file directly.
if (import.meta.main) {
  const summary = await seed();
  console.log("Seeded:", JSON.stringify(summary, null, 2));
  process.exit(0);
}
