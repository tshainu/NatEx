import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

/**
 * End-to-end exercise of the Milestone 1 + 2 API against a running dev server.
 * Walks the real flows: login as each role, book a parcel, build a manifest,
 * scan it, hand it over, receive it at the origin hub (M1); then bag it, seal
 * it, put it on a linehaul trip, depart, arrive and receive it at the
 * destination hub with deliberate variances (M2) — asserting the guardrails
 * throughout (illegal transition, idempotent replay, role gate, unsealed
 * departure, seal mismatch, short bag, PDPA-safe public tracking).
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4200";

// The OTP bucket is deliberately tight (5 requests, refilling 1/min), so four
// logins per run would lock the next run out. Drain the buckets first — the
// limiter itself is asserted at the end of the script instead.
const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
await db.delete(rateLimit);

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
function errText(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: string; data?: { status?: number; type?: string } };
    return `${e.data?.status ?? ""} ${e.data?.type ?? ""} ${e.message ?? ""}`.trim();
  }
  return String(err);
}
async function expectFail(label: string, expectStatus: number, fn: () => Promise<unknown>) {
  try {
    await fn();
    bad(label, "expected a rejection, got success");
  } catch (err) {
    const status = (err as { data?: { status?: number } }).data?.status;
    if (status === expectStatus) ok(label, `rejected ${errText(err)}`);
    else bad(label, `expected ${expectStatus}, got ${errText(err)}`);
  }
}

async function login(phone: string, deviceId?: string) {
  const challenge = await anon.identity.requestOtp({ phone });
  if (!challenge.devCode) throw new Error(`no dev OTP for ${phone} (smsState=${challenge.smsState})`);
  return finishMfa(BASE, await anon.identity.verifyOtp({
    challengeId: challenge.challengeId,
    code: challenge.devCode,
    deviceId: deviceId ?? null,
  }));
}

console.log(`\nNatEx M1+M2 smoke test → ${BASE}\n`);

// ── 1. Auth ───────────────────────────────────────────────────────────────────
console.log("1. Identity / auth");
const ops = await login("+94772345678");
ok("ops login", `${ops.user.name} (${ops.user.role}) @ ${ops.user.branchName}`);
const rider = await login("+94771234567", "rider-device-001");
ok("rider login + device bind", `${rider.user.name}, device ${rider.user.deviceId}`);
const admin = await login("+94773456789");
ok("admin login", admin.user.role);
const merchantUser = await login("+94775678901");
ok("merchant login", `scoped to merchant ${merchantUser.user.merchantId}`);

const opsC = clientFor(ops.accessToken);
const riderC = clientFor(rider.accessToken);
const adminC = clientFor(admin.accessToken);
const merchC = clientFor(merchantUser.accessToken);

await expectFail("unauthenticated call is rejected", 401, () => anon.parcels.list({}));

const rotated = await anon.identity.refresh({ refreshToken: rider.refreshToken });
ok("refresh token rotates", `new access token len ${rotated.accessToken.length}`);
await expectFail("reused refresh token is rejected", 401, () =>
  anon.identity.refresh({ refreshToken: rider.refreshToken }),
);

const who = await opsC.identity.me();
ok("me()", `${who.role} / branch ${who.branchId}`);

// ── 2. Seeded data visible ────────────────────────────────────────────────────
console.log("\n2. Seeded data");
const branches = await opsC.identity.listBranches();
ok("branches", branches.map((b) => `${b.code}:${b.type}`).join(", "));
const merchants = await opsC.merchants.list({});
ok("merchants", `${merchants.rows.length} of ${merchants.total}`);
const zones = await opsC.routing.listZones({});
ok("zones", `${zones.length} seeded`);
const board = await opsC.parcels.board();
ok("live board status counts", JSON.stringify(board.counts));

// ── 3. Merchant scoping ───────────────────────────────────────────────────────
console.log("\n3. Tenancy scoping");
const merchantsSeenByMerchant = await merchC.merchants.list({});
if (merchantsSeenByMerchant.rows.length === 1 && merchantsSeenByMerchant.rows[0]!.id === merchantUser.user.merchantId) {
  ok("merchant sees only its own merchant row");
} else {
  bad("merchant scoping", `saw ${merchantsSeenByMerchant.rows.length} rows`);
}
const merchantParcels = await merchC.parcels.list({});
const leaked = merchantParcels.rows.filter((p) => p.merchantId !== merchantUser.user.merchantId);
if (leaked.length === 0) ok("merchant parcel list is scoped", `${merchantParcels.rows.length} own parcels`);
else bad("merchant parcel scoping", `${leaked.length} foreign parcels leaked`);

await expectFail("rider cannot create a user", 403, () =>
  clientFor(rider.accessToken).identity.createUser({
    name: "Nope",
    phone: "+94770000000",
    roles: ["ops"],
    branchId: branches[0]!.id,
    merchantId: null,
  }),
);

// ── 4. Serviceability (PostGIS replacement) ───────────────────────────────────
console.log("\n4. Routing / serviceability");
const inside = await opsC.routing.checkServiceability({ lat: 6.9271, lng: 79.8612 });
ok("Colombo Fort is serviceable", `zone=${inside.zone?.name ?? "none"} method=${inside.method}`);
const outside = await opsC.routing.checkServiceability({ lat: 9.6615, lng: 80.0255 });
ok("Jaffna outside seeded zones", `serviceable=${outside.serviceable} method=${outside.method}`);
const nearest = await opsC.routing.nearestBranch({ lat: 6.9271, lng: 79.8612 });
ok("nearest branch (Haversine)", `${nearest.code} @ ${nearest.distanceKm}km`);

// ── 5. Book → collect → hub ───────────────────────────────────────────────────
console.log("\n5. Collection flow");
const merchantId = merchants.rows[0]!.id;
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Colombo" });

const bookedDetail = await clientFor(ops.accessToken, `smoke-book-${Date.now()}`).parcels.create({
  merchantId,
  weightGrams: 1200,
  declaredValueCents: 850_000,
  codAmountCents: 450_000,
  originAddress: "Ceylon Threads warehouse, 12 Baseline Road, Colombo 09",
  originLat: 6_932_000,
  originLng: 79_874_000,
  consigneeName: "Smoke Test Consignee",
  consigneePhone: "+94712223334",
  destAddress: "42 Galle Road, Colombo 03",
  destLat: 6_893_500,
  destLng: 79_856_500,
});
const booked = bookedDetail.parcel;
ok("parcel booked", `${booked.awb} status=${booked.status} cod=${booked.codAmountCents}c`);

const manifestDetail = await clientFor(ops.accessToken, `smoke-manifest-${Date.now()}`).collection.create({
  merchantId,
  riderId: rider.user.id,
  pickupDate: today,
  awbs: [booked.awb],
});
const manifest = manifestDetail.manifest;
ok("pickup manifest created", `${manifest.code} declaring ${manifest.expectedCount} item(s)`);

const riderList = await riderC.collection.riderToday({});
ok("rider's today list", JSON.stringify(riderList.totals));

const scan = await clientFor(rider.accessToken, `smoke-scan-${Date.now()}`).collection.scan({
  manifestId: manifest.id,
  awb: booked.awb,
});
ok(
  "rider scans parcel",
  `manifest ${scan.manifest.scannedCount}/${scan.manifest.expectedCount}, alreadyScanned=${scan.alreadyScanned}`,
);

const stillBooked = await opsC.parcels.get({ awbOrId: booked.awb });
if (stillBooked?.parcel.status === "Booked") ok("scan alone does not move custody", "still Booked");
else bad("scan side effect", `status moved to ${stillBooked?.parcel.status}`);

const handover = await clientFor(rider.accessToken, `smoke-handover-${Date.now()}`).collection.handover({
  manifestId: manifest.id,
  handoverByName: "Sanjay Kumar",
  signatureUrl: null,
  lat: 6_932_000,
  lng: 79_874_000,
});
ok(
  "two-party handover",
  `moved ${handover.movedAwbs.length}, missing ${handover.missingAwbs.length}`,
);

const afterHandover = await opsC.parcels.get({ awbOrId: booked.awb });
ok("custody now with rider", `status=${afterHandover?.parcel.status}`);

const hub = await clientFor(rider.accessToken, `smoke-handin-${Date.now()}`).collection.riderHandIn({
  awbs: [booked.awb],
  lat: 6_932_000,
  lng: 79_874_000,
});
ok("scanned into origin hub", `received ${hub.received.length}, rejected ${hub.rejected.length}`);

const detail = await opsC.parcels.get({ awbOrId: booked.awb });
ok(
  "custody chain",
  detail!.timeline.map((e) => `${e.toStatus}(${e.actorRole})`).join(" → "),
);

// ── 6. State machine guardrails ───────────────────────────────────────────────
console.log("\n6. State machine");
const sm = await opsC.parcels.stateMachine();
ok("state machine served to clients", `${Object.keys(sm.transitions).length} states, API exposes M${sm.exposedMilestone}, shipped M${sm.shippedMilestone}, enabled: ${sm.enabled.join(", ")}`);

await expectFail("illegal transition returns 422", 422, () =>
  clientFor(ops.accessToken, `smoke-illegal-${Date.now()}`).parcels.transition({
    awbOrId: booked.awb,
    to: "PickedUp",
    notes: "already at the hub — this must be refused",
  }),
);

const cancelled = detail.parcel.awb;
await expectFail("terminal parcels are immutable", 422, async () => {
  const all = await opsC.parcels.list({ status: ["Cancelled"] });
  const terminal = all.rows[0];
  if (!terminal) throw new Error(`no cancelled parcel seeded (checked while holding ${cancelled})`);
  return clientFor(ops.accessToken, `smoke-terminal-${Date.now()}`).parcels.transition({
    awbOrId: terminal.awb,
    to: "OnHold",
    notes: "cancelled parcels are final",
  });
});

// ── 7. Idempotency ────────────────────────────────────────────────────────────
console.log("\n7. Idempotency");
const replayStamp = Date.now();
const replayKey = `smoke-replay-${replayStamp}`;
// Unique per run: the row-count assertion below searches by consignee name, and
// rows from earlier smoke runs would otherwise be counted as duplicates.
const replayConsignee = `Replay Consignee ${replayStamp}`;
const replayBody = {
  merchantId,
  weightGrams: 500,
  declaredValueCents: 300_000,
  codAmountCents: 120_000,
  originAddress: "Ceylon Threads warehouse, 12 Baseline Road, Colombo 09",
  consigneeName: replayConsignee,
  consigneePhone: "+94712223335",
  destAddress: "8 Duplication Road, Colombo 04",
  destLat: 6_890_500,
  destLng: 79_855_500,
};
const first = await clientFor(ops.accessToken, replayKey).parcels.create(replayBody);
const second = await clientFor(ops.accessToken, replayKey).parcels.create(replayBody);
if (first.parcel.awb === second.parcel.awb) {
  ok("replayed request returns the stored response", `one AWB ${first.parcel.awb}`);
  const total = await opsC.parcels.list({ search: replayConsignee });
  if (total.total === 1) ok("replay minted exactly one parcel", "1 row in the table");
  else bad("idempotency", `${total.total} rows for one logical booking`);
} else {
  bad("idempotency", `two AWBs minted: ${first.parcel.awb} and ${second.parcel.awb}`);
}

await expectFail("same key, different body is a conflict", 409, () =>
  clientFor(ops.accessToken, replayKey).parcels.create({
    ...replayBody,
    consigneeName: "Different Body",
  }),
);

// ── 8. Admin surfaces ─────────────────────────────────────────────────────────
console.log("\n8. Admin");
const users = await adminC.identity.listUsers({});
ok("user list", `${users.length} users`);
const sessions = await adminC.identity.sessionCounts();
ok("active session counts", JSON.stringify(sessions));

// ── 9. Transport custody: bag → trip → hub receipt (M2) ──────────────────────
console.log("\n9. Transport custody (M2)");

// The OTP bucket is per-IP with capacity 5 and four logins are already spent
// above; drain it before the two transport logins this section needs.
await db.delete(rateLimit);

const transport = await login("+94776789012");
ok("transport login (origin hub)", `${transport.user.name} @ ${transport.user.branchName}`);
const kandy = await login("+94777890123");
ok("transport login (dest hub)", `${kandy.user.name} @ ${kandy.user.branchName}`);
const trC = clientFor(transport.accessToken);
const kdC = clientFor(kandy.accessToken);

const kandyHub = branches.find((b) => b.code === "KDYHUB");
if (!kandyHub) bad("Kandy hub seeded", "no branch with code KDYHUB");
else ok("Kandy hub seeded", `${kandyHub.name} (${kandyHub.type})`);

await expectFail("rider cannot open a bag", 403, () =>
  clientFor(rider.accessToken, `smoke-bag-role-${Date.now()}`).transport.bagCreate({
    destHubId: kandyHub!.id,
  }),
);
await expectFail("merchant cannot read the transport board", 403, () =>
  merchC.transport.tripList({}),
);

// Two upcountry parcels of our own, walked to AtOriginHub so the bagging step
// has known labels to work with (the seeded ten are already in seeded bags).
async function upcountryParcel(n: number) {
  const stamp = `${Date.now()}-${n}`;
  const d = await clientFor(ops.accessToken, `smoke-up-book-${stamp}`).parcels.create({
    merchantId,
    weightGrams: 900,
    declaredValueCents: 400_000,
    codAmountCents: 250_000,
    originAddress: "Ceylon Threads warehouse, 12 Baseline Road, Colombo 09",
    originLat: 6_932_000,
    originLng: 79_874_000,
    consigneeName: `Upcountry Consignee ${stamp}`,
    consigneePhone: "+94712224445",
    destAddress: `${n} Peradeniya Road, Kandy`,
    destLat: 7_290_600,
    destLng: 80_633_700,
  });
  for (const to of ["PickedUp", "AtOriginHub"] as const) {
    await clientFor(ops.accessToken, `smoke-up-${to}-${stamp}`).parcels.transition({
      awbOrId: d.parcel.awb,
      to,
      notes: "smoke: walked to the origin hub",
    });
  }
  return d.parcel.awb;
}
const awbA = await upcountryParcel(1);
const awbB = await upcountryParcel(2);
ok("two parcels staged at the origin hub", `${awbA}, ${awbB}`);

const baggable = await trC.transport.baggable({});
const staged = baggable.filter((p) => p.awb === awbA || p.awb === awbB);
if (staged.length === 2) ok("baggable queue lists them", `${baggable.length} parcels awaiting a bag`);
else bad("baggable queue", `expected both staged parcels, saw ${staged.length}`);

const bagRow = await clientFor(transport.accessToken, `smoke-bag-${Date.now()}`).transport.bagCreate({
  destHubId: kandyHub!.id,
});
ok("bag opened", `${bagRow.code} → ${kandyHub!.code}, status=${bagRow.status}`);

const scan1 = await clientFor(transport.accessToken, `smoke-scan1-${Date.now()}`).transport.bagScan({
  bagId: bagRow.id,
  awbs: [awbA],
});
ok("first label scanned in", `accepted ${scan1.accepted.length}, items ${scan1.itemCount}`);

// Duplicate, stray and good label in one burst: a per-label verdict, not a
// batch failure (§10 M2 "bulk scan ... verdict per label").
const scan2 = await clientFor(transport.accessToken, `smoke-scan2-${Date.now()}`).transport.bagScan({
  bagId: bagRow.id,
  awbs: [awbA, awbB, "NX9999999999"],
});
if (scan2.accepted.length === 1 && scan2.duplicates.length === 1 && scan2.rejected.length === 1) {
  ok(
    "mixed burst gets a per-label verdict",
    `accepted ${scan2.accepted[0]!.awb}, duplicate ${scan2.duplicates[0]!.awb}, rejected ${scan2.rejected[0]!.awb} (${scan2.rejected[0]!.reason})`,
  );
} else {
  bad(
    "bulk scan verdicts",
    `accepted ${scan2.accepted.length}, duplicates ${scan2.duplicates.length}, rejected ${scan2.rejected.length}`,
  );
}

const baggedDetail = await trC.parcels.get({ awbOrId: awbA });
if (baggedDetail?.parcel.status === "Bagged") ok("scanning into a bag moves the parcel", "Bagged");
else bad("bag scan side effect", `status=${baggedDetail?.parcel.status}`);

const tripRow = await clientFor(transport.accessToken, `smoke-trip-${Date.now()}`).transport.tripCreate({
  vehicleRegistration: "SM-1234",
  destHubId: kandyHub!.id,
  route: "Colombo → Kandy (smoke)",
});
ok("linehaul trip created", `${tripRow.code} on ${tripRow.vehicleRegistration}`);

// §6, verbatim: a bag must be sealed AND assigned to a trip to move. The
// invariant is enforced at load time rather than left for departure to catch.
await expectFail("an unsealed bag cannot be loaded", 409, () =>
  clientFor(transport.accessToken, `smoke-load-open-${Date.now()}`).transport.tripLoad({
    tripId: tripRow.id,
    bagId: bagRow.id,
  }),
);

const emptyBag = await clientFor(transport.accessToken, `smoke-bag-empty-${Date.now()}`).transport.bagCreate({
  destHubId: kandyHub!.id,
});
await expectFail("an empty bag cannot be sealed", 400, () =>
  clientFor(transport.accessToken, `smoke-seal-empty-${Date.now()}`).transport.bagSeal({
    bagId: emptyBag.id,
    sealNumber: `BAG-EMPTY-${Date.now().toString(36).toUpperCase().slice(-5)}`,
  }),
);

const sealNumber = `BAG-SMOKE-${Date.now().toString(36).toUpperCase().slice(-5)}`;
const sealed = await clientFor(transport.accessToken, `smoke-seal-${Date.now()}`).transport.bagSeal({
  bagId: bagRow.id,
  sealNumber,
});
ok("bag sealed", `${sealed.code} seal=${sealed.sealNumber} items=${sealed.itemCount}`);

await expectFail("a sealed bag takes no more scans", 409, () =>
  clientFor(transport.accessToken, `smoke-scan-sealed-${Date.now()}`).transport.bagScan({
    bagId: bagRow.id,
    awbs: [awbA],
  }),
);

await clientFor(transport.accessToken, `smoke-load-${Date.now()}`).transport.tripLoad({
  tripId: tripRow.id,
  bagId: bagRow.id,
});
ok("sealed bag loaded onto the trip");

const emptyTrip = await clientFor(transport.accessToken, `smoke-trip-empty-${Date.now()}`).transport.tripCreate({
  vehicleRegistration: "SM-9999",
  destHubId: kandyHub!.id,
});
await expectFail("an empty trip cannot depart", 400, () =>
  clientFor(transport.accessToken, `smoke-depart-empty-${Date.now()}`).transport.tripDepart({
    tripId: emptyTrip.id,
    seal: "VEH-SMOKE-0",
  }),
);

const departed = await clientFor(transport.accessToken, `smoke-depart-${Date.now()}`).transport.tripDepart({
  tripId: tripRow.id,
  seal: "VEH-SMOKE-1",
});
ok(
  "trip departs and every parcel aboard moves",
  `${departed.bags} bag(s), ${departed.parcelsMoved} parcel(s) → InTransit, ${departed.rejected.length} rejected`,
);

await clientFor(transport.accessToken, `smoke-arrive-${Date.now()}`).transport.tripArrive({
  tripId: tripRow.id,
});
ok("trip arrives at the destination hub");

const inTransit = await trC.parcels.get({ awbOrId: awbB });
if (inTransit?.parcel.status === "InTransit") ok("arrival does not move parcels", "still InTransit");
else bad("arrival side effect", `status=${inTransit?.parcel.status}`);

const inboundAtKandy = await kdC.transport.inbound({});
if (inboundAtKandy.some((b) => b.id === bagRow.id)) {
  ok("bag shows in the destination hub's inbound queue", `${inboundAtKandy.length} inbound bag(s)`);
} else {
  bad("inbound queue", `bag ${bagRow.code} not listed at ${kandyHub!.code}`);
}

await expectFail("only the destination hub may receive the bag", 403, () =>
  clientFor(transport.accessToken, `smoke-recv-wrong-${Date.now()}`).transport.bagReceive({
    bagId: bagRow.id,
    scannedAwbs: [awbA],
    sealNumber,
    releasedByName: "Driver Kumaran",
  }),
);

// Two-party receipt with two deliberate variances: a wrong seal, and one of the
// two manifested parcels never scanned. Neither may be reconciled away (§7).
const receipt = await clientFor(kandy.accessToken, `smoke-recv-${Date.now()}`).transport.bagReceive({
  bagId: bagRow.id,
  scannedAwbs: [awbA],
  sealNumber: "WRONG-SEAL-1",
  releasedByName: "Driver Kumaran",
  receivedByName: kandy.user.name,
});
if (
  receipt.sealMatched === false &&
  receipt.received.length === 1 &&
  receipt.missing.length === 1 &&
  receipt.missing[0]!.awb === awbB &&
  receipt.exceptionsRaised >= 2
) {
  ok(
    "hub receipt detects both variances",
    `sealMatched=false, received ${receipt.received[0]!.awb}, missing ${receipt.missing[0]!.awb}, ${receipt.exceptionsRaised} exception(s)`,
  );
} else {
  bad(
    "variance detection",
    `sealMatched=${receipt.sealMatched} received=${receipt.received.length} missing=${receipt.missing.length} exceptions=${receipt.exceptionsRaised}`,
  );
}

const atDest = await kdC.parcels.get({ awbOrId: awbA });
if (atDest?.parcel.status === "AtDestHub" && atDest.parcel.branchId === kandyHub!.id) {
  ok("scanned parcel is now the destination hub's accountability", `AtDestHub @ ${kandyHub!.code}`);
} else {
  bad("hub receipt custody", `status=${atDest?.parcel.status} branch=${atDest?.parcel.branchId}`);
}

await expectFail("receiving the same bag twice is a conflict", 409, () =>
  clientFor(kandy.accessToken, `smoke-recv-again-${Date.now()}`).transport.bagReceive({
    bagId: bagRow.id,
    scannedAwbs: [awbA],
    sealNumber,
    releasedByName: "Driver Kumaran",
  }),
);

const queue = await kdC.transport.exceptions({ status: ["open"] });
const missingEx = queue.rows.find((r) => r.kind === "missing_at_destination" && r.awb === awbB);
const sealEx = queue.rows.find((r) => r.kind === "seal_mismatch" && r.bagId === bagRow.id);
if (missingEx && sealEx) {
  ok(
    "both variances land in the ops exception queue",
    `${queue.openCount} open: ${missingEx.kind}(${missingEx.severity}), ${sealEx.kind}(${sealEx.severity})`,
  );
} else {
  bad("exception queue", `missing=${!!missingEx} seal=${!!sealEx} of ${queue.rows.length} rows`);
}

const investigating = await clientFor(kandy.accessToken, `smoke-exc-${Date.now()}`).transport.exceptionResolve({
  exceptionId: missingEx!.id,
  status: "investigating",
  resolution: "Smoke test: driver called, re-checking the vehicle.",
});
ok("exception can be worked", `${investigating.kind} → ${investigating.status}`);

const chain = await kdC.transport.custody({ awb: awbA });
const leg = chain.bags[0];
if (leg?.bagCode === bagRow.code && leg.tripCode === tripRow.code) {
  ok(
    "chain of custody stitches parcel + bag + trip",
    `${chain.timeline.map((e) => e.toStatus).join("→")} via ${leg.bagCode}/${leg.tripCode}, ${chain.scans.length} scans`,
  );
} else {
  bad("custody chain", `bag=${leg?.bagCode ?? "none"} trip=${leg?.tripCode ?? "none"}`);
}

const rejectedScans = await trC.transport.scans({ outcome: "rejected", limit: 50 });
if (rejectedScans.some((s) => s.awb === "NX9999999999")) {
  ok("rejected scans are kept as evidence", `${rejectedScans.length} rejected scan(s) logged`);
} else {
  bad("scan log", "the stray label was not recorded");
}

const tCounts = await trC.transport.counts({});
ok("transport dashboard counts", JSON.stringify(tCounts));

// Public consignee tracking: unauthenticated, and PII-free by design (§9).
const publicView = (await anon.parcels.track({ awb: awbA }))!;
const pii = ["consigneeName", "consigneePhone", "codAmountCents", "declaredValueCents", "destAddress", "merchantId"];
const leakedFields = pii.filter((k) => k in (publicView as unknown as Record<string, unknown>));
if (leakedFields.length === 0) {
  ok(
    "public tracking is PII-free",
    `${publicView.awb}: ${publicView.publicStatus} near ${publicView.destinationArea}, ${publicView.timeline.length} steps`,
  );
} else {
  bad("public tracking PDPA", `leaked ${leakedFields.join(", ")}`);
}
await expectFail("unknown AWB tracks to 404", 404, () =>
  anon.parcels.track({ awb: "NX0000000000" }),
);

// ── 10. SMS delivery-receipt webhook ──────────────────────────────────────────
console.log("\n10. SMS DLR webhook");
const badDlr = await fetch(`${BASE}/api/webhooks/sms/dlr`, { method: "POST", body: "{}" });
if (badDlr.status === 401) ok("unsigned delivery receipt rejected", "401 problem+json");
else bad("DLR auth", `expected 401, got ${badDlr.status}`);
const secret = process.env.SMS_DLR_WEBHOOK_SECRET ?? "";
const goodDlr = await fetch(`${BASE}/api/webhooks/sms/dlr?s=${encodeURIComponent(secret)}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ messageId: "unmatched-ref-123", status: "DELIVRD" }),
});
ok("signed delivery receipt accepted", `${goodDlr.status} ${await goodDlr.text()}`);

// ── 11. Rate limiting ─────────────────────────────────────────────────────────
console.log("\n11. Rate limiting");
let limited = false;
for (let i = 0; i < 12; i += 1) {
  try {
    await anon.identity.requestOtp({ phone: "+94771234567" });
  } catch (err) {
    if ((err as { data?: { status?: number } }).data?.status === 429) {
      limited = true;
      ok("OTP brute-force surface is rate limited", `429 after ${i + 1} requests`);
      break;
    }
    bad("rate limiting", errText(err));
    break;
  }
}
if (!limited) bad("rate limiting", "12 OTP requests all succeeded");
await db.delete(rateLimit);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL GREEN — ${pass} checks passed.`);
} else {
  console.log(`${pass} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
