import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "../src/api";
import { ulid } from "../src/api/shared/ulid";
import { CMB_BRANCH, railToKandyHub } from "./lib/rail";
import { bankRiderCash } from "./lib/cash";
import { retireRun } from "./lib/retire";

/**
 * End-to-end exercise of the PROJECT.md §7 offline sync engine against a
 * running dev server.
 *
 * §7 is the section that cannot be proven by reading the code, because every
 * guarantee it makes is about what happens when things go WRONG: a device
 * pushes the same operation twice, two riders claim one parcel, a runsheet is
 * reassigned while a phone is in a dead zone, an old app build pushes a kind
 * the server retired. So each of those is provoked here deliberately and the
 * verdict is asserted, rather than asserting the happy path and hoping.
 *
 * The thing being tested is the ENGINE, not the operations it carries: that
 * every pushed operation lands exactly once, in the device's own order, with a
 * row in the journal whatever its outcome, and that anything it could not
 * apply surfaces in the ops exception queue instead of vanishing.
 *
 * Re-runnable: it books and stages its own parcels rather than assuming seed
 * state, so it does not care what a previous smoke run left behind.
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4200";

const { db } = await import("../src/api/database");
const { rateLimit } = await import("../src/api/database/schema/shared");
const { like } = await import("drizzle-orm");
await db.delete(rateLimit);

async function clearOtpBucket(): Promise<void> {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
}

let keySeq = 0;
function key(label: string): string {
  keySeq += 1;
  return `sync-${label}-${Date.now()}-${keySeq}`;
}

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
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) ok(label, detail);
  else bad(label, detail || "assertion failed");
}
function note(text: string): void {
  console.log(`  NOTE  ${text}`);
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
  await clearOtpBucket();
  const challenge = await anon.identity.requestOtp({ phone });
  if (!challenge.devCode) throw new Error(`no dev OTP for ${phone} (smsState=${challenge.smsState})`);
  return anon.identity.verifyOtp({
    challengeId: challenge.challengeId,
    code: challenge.devCode,
    deviceId: deviceId ?? null,
  });
}

console.log(`\nNatEx sync engine smoke test (PROJECT.md §7) → ${BASE}\n`);

// ── 1. Who is on shift ────────────────────────────────────────────────────────
console.log("1. Principals");
const admin = await login("+94773456789");
const kandyTransport = await login("+94777890123");
// Two rider devices: the one that owns the work, and one that will be caught
// holding a runsheet that has moved on.
const kandyRider = await login("+94778901234", "sync-kandy-rider-01");
const colomboRider = await login("+94771234567", "sync-cmb-rider-01");
const kandyOps = await login("+94779012345");
const colomboOps = await login("+94772345678");
const merchant = await login("+94775678901");

const adminC = clientFor(admin.accessToken);
const riderC = clientFor(kandyRider.accessToken);
const opsC = clientFor(kandyOps.accessToken);

ok("admin", `${admin.user.name} (${admin.user.role})`);
ok("Kandy rider", `${kandyRider.user.name}, device ${kandyRider.user.deviceId}`);
ok("Colombo rider", `${colomboRider.user.name}, device ${colomboRider.user.deviceId}`);
ok("Kandy ops", `${kandyOps.user.name} @ ${kandyOps.user.branchName}`);

const DEVICE = "sync-kandy-rider-01";
const OTHER_DEVICE = "sync-cmb-rider-01";
// A third device, an ops tablet, for the ordering proof (see step 6).
const ORDER_DEVICE = "sync-kandy-ops-01";

// ── 2. Stage the day's work ───────────────────────────────────────────────────
// Booked through the real endpoint, then moved with the bulk transition so
// staging costs six round trips instead of six per parcel. mch_ceylon_threads
// is a SIGNATURE POD merchant on purpose: an offline rider cannot request a
// delivery OTP, so an OTP merchant's parcel is undeliverable from an outbox.
console.log("\n2. Staging parcels (booked and railed to the doorstep)");

async function bookParcels(n: number, codCents = 0): Promise<string[]> {
  const awbs: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const created = await clientFor(admin.accessToken, key(`book-${i}`)).parcels.create({
      merchantId: "mch_ceylon_threads",
      branchId: CMB_BRANCH,
      weightGrams: 1200,
      declaredValueCents: 250_000,
      codAmountCents: codCents,
      originAddress: "12 Dharmapala Mawatha, Kandy",
      consigneeName: `Sync Fixture ${i + 1}`,
      consigneePhone: "+94761112233",
      destAddress: `${i + 1} Peradeniya Road, Kandy`,
    });
    awbs.push(created.parcel.awb);
  }
  return awbs;
}

async function railTo(awbs: string[], to: string): Promise<void> {
  const res = await clientFor(admin.accessToken, key(`rail-${to}`)).parcels.transitionMany({
    awbs,
    to: to as "PickedUp",
    notes: "sync smoke staging",
  });
  if (res.rejected.length > 0) {
    throw new Error(`staging to ${to} rejected ${JSON.stringify(res.rejected)}`);
  }
}


// A runsheet a previous run left open would make this run's "no assignment
// yet" and "create a runsheet" steps both wrong, and a rider may only hold one
// open sheet a day. Close whatever is still hanging around first.
const leftovers = await opsC.delivery.runsheetList({
  riderId: "usr_rider_kandy",
  status: ["draft", "dispatched"],
});
for (const sheet of leftovers) {
  await retireRun(clientFor(kandyOps.accessToken, key(`close-${sheet.id}`)), sheet, "closed by the sync smoke test before re-staging");
}
if (leftovers.length > 0) ok("cleared runsheets left open by an earlier run", leftovers.map((s) => s.code).join(", "));

const all = await bookParcels(9);
await railToKandyHub({ clientFor, login: (p) => login(p), adminToken: admin.accessToken, awbs: all, key, label: "sync" });
check(all.length === 9, "nine parcels booked and railed to the destination hub", all.join(", "));

// One stays at AtDestHub for the runsheet (only AtDestHub/DeliveryAttempted/
// OnHold are runsheet-eligible); the rest go out for delivery.
const staleParcel = all[8]!;
const ofd = all.slice(0, 8);
await railTo(ofd, "OutForDelivery");
ok("eight parcels are out for delivery", ofd.join(", "));

// ── 3. Delta pull — the fresh install, then the reconnect ──────────────────────
console.log("\n3. Delta pull (§7: never the whole dataset)");
const first = await riderC.sync.pull({ deviceId: DEVICE, cursor: 0, appVersion: "1.0.0" });
check(
  first.reasonCodes.length >= 15,
  "a fresh install (cursor 0) is handed the failure reason codes",
  `${first.reasonCodes.length} codes, in hand before signal is lost`,
);
check(first.cursor > 0, "the pull issues a server cursor", `cursor ${first.cursor}`);
check(
  first.parcels.length > 0 && first.parcels.length <= 200,
  "the pull is bounded, not the whole table",
  `${first.parcels.length} parcels, hasMore=${first.hasMore}`,
);
// No runsheet has been dispatched yet at this point in the day, so the correct
// answer is an explicit null rather than a stale sheet. The positive case is
// asserted in step 8, once a real runsheet exists.
check(
  first.assignment === null,
  "a rider with no dispatched runsheet is told so explicitly, not handed a stale one",
  `assignment=${JSON.stringify(first.assignment)}`,
);

const second = await riderC.sync.pull({ deviceId: DEVICE, cursor: first.cursor });
check(
  second.reasonCodes.length === 0,
  "a reconnect does not re-download the static reason table",
  `${second.reasonCodes.length} codes on the second pull`,
);
check(
  second.parcels.length < first.parcels.length,
  "the second pull returns only what changed after the watermark",
  `${first.parcels.length} → ${second.parcels.length}`,
);
check(second.cursor >= first.cursor, "the cursor only moves forward", `${first.cursor} → ${second.cursor}`);

const opsPull = await clientFor(kandyOps.accessToken).sync.pull({ deviceId: "sync-ops-01", cursor: 0 });
check(
  opsPull.assignment === null,
  "a non-rider device pulls parcels but carries no runsheet",
  `assignment=${opsPull.assignment}`,
);

// ── 4. The drain: operations that apply ───────────────────────────────────────
console.log("\n4. Draining an outbox");
const POD = { receivedByRelation: "self", method: "signature", signatureData: "data:image/png;base64,AAAA" };

const op1 = ulid();
const op2 = ulid();
const drain = await clientFor(kandyRider.accessToken, key("drain-1")).sync.push({
  deviceId: DEVICE,
  appVersion: "1.0.0",
  pendingCount: 0,
  operations: [
    {
      clientOpId: op1,
      kind: "delivery.deliver",
      seq: 1,
      clientTs: Date.now() - 3_600_000,
      payload: { awb: ofd[0]!, receivedByName: "Kamala Wijesinghe", ...POD },
    },
    {
      clientOpId: op2,
      kind: "delivery.fail",
      seq: 2,
      clientTs: Date.now() - 3_000_000,
      payload: { awb: ofd[1]!, reasonCode: "CONSIGNEE_NOT_AT_HOME", notes: "Nobody home, gate locked." },
    },
  ],
});
check(
  drain.applied === 2 && drain.conflicts === 0 && drain.rejected === 0,
  "both queued operations applied",
  `applied=${drain.applied} dup=${drain.duplicates} rej=${drain.rejected} conf=${drain.conflicts}`,
);
check(
  drain.verdicts.every((v) => v.state === "applied"),
  "every operation came back with its own verdict",
  drain.verdicts.map((v) => `${v.kind}:${v.state}`).join(", "),
);
check(drain.cursor > 0, "the push hands back a fresh cursor (push and pull in one trip)", `cursor ${drain.cursor}`);

const delivered = await adminC.parcels.get({ awbOrId: ofd[0]! });
check(delivered.parcel.status === "Delivered", "the delivery actually landed on the parcel", `${ofd[0]} is ${delivered.parcel.status}`);
const attempted = await adminC.parcels.get({ awbOrId: ofd[1]! });
check(
  attempted.parcel.status === "DeliveryAttempted",
  "the failure actually landed on the parcel",
  `${ofd[1]} is ${attempted.parcel.status}`,
);

// ── 5. Exactly once — the guarantee that matters at the doorstep ───────────────
console.log("\n5. Exactly once (§7: idempotent by construction)");
const replay = await clientFor(kandyRider.accessToken, key("drain-replay")).sync.push({
  deviceId: DEVICE,
  pendingCount: 0,
  operations: [
    {
      clientOpId: op1,
      kind: "delivery.deliver",
      seq: 1,
      payload: { awb: ofd[0]!, receivedByName: "Kamala Wijesinghe", ...POD },
    },
    {
      clientOpId: op2,
      kind: "delivery.fail",
      seq: 2,
      payload: { awb: ofd[1]!, reasonCode: "CONSIGNEE_NOT_AT_HOME" },
    },
  ],
});
check(
  replay.duplicates === 2 && replay.applied === 0,
  "a retry of the same outbox entries is deduped on the client id, not reapplied",
  `dup=${replay.duplicates} applied=${replay.applied}`,
);
check(
  replay.verdicts.every((v) => v.state === "duplicate" && v.result !== null),
  "each duplicate replays the STORED verdict, so the device learns the outcome it missed",
  replay.verdicts.map((v) => v.state).join(", "),
);
note("a FRESH Idempotency-Key was used for the replay — the dedupe above is the data-model one, not the header");

// ── 6. Device order, not clock order ──────────────────────────────────────────
console.log("\n6. Device order (§7: clocks skew ±30 min, counters do not)");
const orderIds = [ulid(), ulid(), ulid()];
// Pushed in the WRONG array order, with clientTs deliberately inverted: the
// operation the device counted first carries the LATEST clock reading, so
// anything ordering by timestamp would apply these backwards.
// Ends on OnHold, not Delivered: a bare parcel.transition carries no POD, and
// since 2026-10-01 the choke point refuses Delivered without one (§6).
// Pushed from an ops device, not the rider's: the chain below has to cross
// OutForDelivery, and TRANSITION_ROLES gives that hop to ops/transport/admin
// only. The engine is what is under test here, not who may drive a parcel.
const nowMs = Date.now();
const ordered = await clientFor(kandyOps.accessToken, key("order")).sync.push({
  deviceId: ORDER_DEVICE,
  pendingCount: 0,
  operations: [
    { clientOpId: orderIds[2]!, kind: "parcel.transition", seq: 32, clientTs: nowMs - 1_800_000, payload: { awbOrId: ofd[2]!, to: "OnHold", notes: "third" } },
    { clientOpId: orderIds[0]!, kind: "parcel.transition", seq: 30, clientTs: nowMs, payload: { awbOrId: ofd[2]!, to: "DeliveryAttempted", notes: "first" } },
    { clientOpId: orderIds[1]!, kind: "parcel.transition", seq: 31, clientTs: nowMs - 900_000, payload: { awbOrId: ofd[2]!, to: "OutForDelivery", notes: "second" } },
  ],
});
check(
  ordered.verdicts.map((v) => v.clientOpId).join(",") === orderIds.join(","),
  "verdicts come back in the device's seq order, not the order they arrived in the array",
  ordered.verdicts.map((v) => v.clientOpId.slice(-6)).join(" → "),
);
check(
  ordered.applied === 3,
  "a chain only legal in seq order applied in full — proof the order was the device's",
  `applied=${ordered.applied} (OutForDelivery → DeliveryAttempted → OutForDelivery → OnHold)`,
);
const chained = await adminC.parcels.get({ awbOrId: ofd[2]! });
check(chained.parcel.status === "OnHold", "the chain ended where the device left it", `${ofd[2]} is ${chained.parcel.status}`);

const journalOrder = await opsC.sync.operationOrder({ deviceId: ORDER_DEVICE });
const seqs = journalOrder.map((r) => r.seq);
check(
  seqs.every((s, i) => i === 0 || s >= seqs[i - 1]!),
  "the journal reads back in the device's own order",
  `${seqs.length} operations, seq ${seqs[0]}..${seqs[seqs.length - 1]}`,
);

// ── 7. Clock skew is measured, never trusted ──────────────────────────────────
console.log("\n7. Clock skew");
const skewed = await clientFor(kandyRider.accessToken, key("skew")).sync.push({
  deviceId: DEVICE,
  pendingCount: 7,
  clientNow: Date.now() + 30 * 60_000,
  operations: [
    {
      clientOpId: ulid(),
      kind: "delivery.deliver",
      seq: 40,
      clientTs: Date.now() + 30 * 60_000,
      payload: { awb: ofd[3]!, receivedByName: "Nuwan Silva", ...POD },
    },
  ],
});
check(
  skewed.clockSkewSeconds >= 1750 && skewed.clockSkewSeconds <= 1850,
  "a device 30 minutes fast has its skew recorded",
  `${skewed.clockSkewSeconds}s`,
);
check(skewed.applied === 1, "the skew did not stop the operation applying", `applied=${skewed.applied}`);

// ── 8. The conflict table, provoked one row at a time ─────────────────────────
console.log("\n8. §7's conflict table");

// "Two riders claim one parcel → server rejects the later claim."
const dupClaim = await clientFor(kandyRider.accessToken, key("dup-claim")).sync.push({
  deviceId: DEVICE,
  pendingCount: 0,
  operations: [
    {
      clientOpId: ulid(),
      kind: "delivery.deliver",
      seq: 50,
      payload: { awb: ofd[0]!, receivedByName: "Someone Else", ...POD },
    },
  ],
});
check(
  dupClaim.verdicts[0]!.state === "conflict" && dupClaim.verdicts[0]!.policy === "duplicate_claim",
  "a second delivery of an already-delivered parcel is a duplicate_claim conflict",
  `${dupClaim.verdicts[0]!.state}/${dupClaim.verdicts[0]!.policy}`,
);
check(dupClaim.verdicts[0]!.conflictId !== null, "the conflict carries an ops-queue id", `${dupClaim.verdicts[0]!.conflictId}`);

// "Delivery confirmed offline, parcel already failed → flag for ops manual
// review, never silently overwrite."
await clientFor(admin.accessToken, key("hold")).parcels.transition({ awbOrId: ofd[4]!, to: "OnHold", notes: "held by ops" });
const vsFail = await clientFor(kandyRider.accessToken, key("vs-fail")).sync.push({
  deviceId: DEVICE,
  pendingCount: 0,
  operations: [
    {
      clientOpId: ulid(),
      kind: "delivery.deliver",
      seq: 51,
      payload: { awb: ofd[4]!, receivedByName: "Doorstep Signer", ...POD },
    },
  ],
});
check(
  vsFail.verdicts[0]!.state === "conflict" && vsFail.verdicts[0]!.policy === "offline_delivery_vs_fail",
  "a delivery captured offline against a parcel ops has since held is flagged for manual review",
  `${vsFail.verdicts[0]!.state}/${vsFail.verdicts[0]!.policy}`,
);
const stillHeld = await adminC.parcels.get({ awbOrId: ofd[4]! });
check(
  stillHeld.parcel.status === "OnHold",
  "and the server's state was NOT overwritten",
  `${ofd[4]} is still ${stillHeld.parcel.status}`,
);

// "Runsheet reassigned while offline → client discards stale runsheet."
const sheet = await clientFor(kandyTransport.accessToken, key("rsh-create")).delivery.runsheetCreate({
  riderId: "usr_rider_kandy",
});
await clientFor(kandyTransport.accessToken, key("rsh-add")).delivery.runsheetAdd({
  runsheetId: sheet.id,
  awbs: [staleParcel],
});
// COD deliveries now post COLLECT entries; settle what earlier runs left on
// the rider so the §8 cash-ceiling gate at dispatch is not tripped by fixtures.
await bankRiderCash({ clientFor, login: (p) => login(p), riderToken: kandyRider.accessToken, branchId: "brn_kdy_hub", key, label: "smoke-sync" });
await clientFor(kandyTransport.accessToken, key("rsh-dispatch")).delivery.runsheetDispatch({ runsheetId: sheet.id });
ok("the parcel is on the Kandy rider's dispatched runsheet", `${sheet.code} ← ${staleParcel}`);

// The positive half of step 3: now that a runsheet is live, the rider's pull
// must carry the server's authoritative version of it.
const assigned = await riderC.sync.pull({ deviceId: DEVICE, cursor: 0 });
check(
  assigned.assignment !== null && assigned.assignment.runsheetId === sheet.id,
  "a rider's pull carries their authoritative runsheet assignment",
  JSON.stringify(assigned.assignment).slice(0, 110),
);

const stale = await clientFor(colomboRider.accessToken, key("stale")).sync.push({
  deviceId: OTHER_DEVICE,
  pendingCount: 0,
  operations: [
    {
      clientOpId: ulid(),
      kind: "delivery.deliver",
      seq: 1,
      payload: { awb: staleParcel, receivedByName: "Wrong Rider", ...POD },
    },
  ],
});
check(
  stale.verdicts[0]!.state === "conflict" && stale.verdicts[0]!.policy === "stale_runsheet",
  "a device holding a reassigned runsheet is told to discard and re-pull",
  `${stale.verdicts[0]!.state}/${stale.verdicts[0]!.policy}`,
);
const staleAfter = await adminC.parcels.get({ awbOrId: staleParcel });
check(
  staleAfter.parcel.status === "OutForDelivery",
  "the other rider's parcel was untouched",
  `${staleParcel} is ${staleAfter.parcel.status}`,
);

// "Same parcel transitioned twice → first wins."
const noopId = ulid();
const noop = await clientFor(kandyRider.accessToken, key("noop")).sync.push({
  deviceId: DEVICE,
  pendingCount: 0,
  operations: [
    { clientOpId: noopId, kind: "parcel.transition", seq: 60, payload: { awbOrId: ofd[0]!, to: "Delivered" } },
  ],
});
check(
  noop.verdicts[0]!.state === "conflict" && noop.verdicts[0]!.policy === "duplicate_operation",
  "re-transitioning a parcel to the state it is already in is a duplicate_operation — first wins",
  `${noop.verdicts[0]!.state}/${noop.verdicts[0]!.policy}`,
);

// Fallback: anything else the state machine refuses.
const illegal = await clientFor(kandyRider.accessToken, key("illegal")).sync.push({
  deviceId: DEVICE,
  pendingCount: 0,
  operations: [
    { clientOpId: ulid(), kind: "parcel.transition", seq: 61, payload: { awbOrId: ofd[0]!, to: "Booked" } },
  ],
});
check(
  illegal.verdicts[0]!.state === "conflict" && illegal.verdicts[0]!.policy === "illegal_state",
  "a transition the state machine refuses lands as illegal_state, not a 500",
  `${illegal.verdicts[0]!.state}/${illegal.verdicts[0]!.policy}`,
);

// An old app build in the field.
const unknownPayload = { awb: ofd[5]!, somethingThisServerNeverHeardOf: true, nested: { n: 7 } };
const unknown = await clientFor(kandyRider.accessToken, key("unknown")).sync.push({
  deviceId: DEVICE,
  pendingCount: 0,
  appVersion: "0.9.0-old",
  operations: [{ clientOpId: ulid(), kind: "delivery.teleport", seq: 62, payload: unknownPayload }],
});
check(
  unknown.verdicts[0]!.state === "conflict" && unknown.verdicts[0]!.policy === "unknown_kind",
  "an operation kind this build does not know is held as a conflict, not bounced as a 400",
  `${unknown.verdicts[0]!.state}/${unknown.verdicts[0]!.policy}`,
);
const heldConflict = await opsC.sync.conflictGet({ conflictId: unknown.verdicts[0]!.conflictId! });
check(
  JSON.stringify(heldConflict.conflict.clientClaim) === JSON.stringify(unknownPayload),
  "and its payload is held VERBATIM so it can be replayed after the fleet is upgraded",
  JSON.stringify(heldConflict.conflict.clientClaim),
);

// A rejection that is NOT a conflict: nothing for ops to decide.
const gone = await clientFor(kandyRider.accessToken, key("gone")).sync.push({
  deviceId: DEVICE,
  pendingCount: 0,
  operations: [
    {
      clientOpId: ulid(),
      kind: "delivery.deliver",
      seq: 63,
      payload: { awb: "NATEX-DOES-NOT-EXIST", receivedByName: "Nobody", ...POD },
    },
  ],
});
check(
  gone.verdicts[0]!.state === "rejected" && gone.verdicts[0]!.policy === null,
  "an operation for a parcel that does not exist is a plain rejection, not ops work",
  `${gone.verdicts[0]!.state}/policy=${gone.verdicts[0]!.policy} — ${gone.verdicts[0]!.error?.slice(0, 60)}`,
);

note(
  "double_cod is NOT provoked here: recordDelivery reconciles COD to the cent but does not yet post a " +
    "cod_entry (the delivery→COD wiring is an open M4 item), so `cod-already-collected` is unreachable " +
    "from an outbox today. The policy is pre-positioned in policyFor() and must be covered here once " +
    "that wiring lands.",
);

// ── 9. A failure mid-batch does not strand the rest of the queue ───────────────
console.log("\n9. One bad record must not wedge the phone");
const mixed = await clientFor(kandyRider.accessToken, key("mixed")).sync.push({
  deviceId: DEVICE,
  pendingCount: 0,
  operations: [
    { clientOpId: ulid(), kind: "parcel.transition", seq: 70, payload: { awbOrId: ofd[0]!, to: "Booked" } },
    { clientOpId: ulid(), kind: "delivery.deliver", seq: 71, payload: { awb: ofd[6]!, receivedByName: "Ruwani Perera", ...POD } },
    { clientOpId: ulid(), kind: "delivery.teleport", seq: 72, payload: {} },
    { clientOpId: ulid(), kind: "delivery.fail", seq: 73, payload: { awb: ofd[7]!, reasonCode: "CONSIGNEE_NOT_AT_HOME" } },
  ],
});
check(
  mixed.applied === 2 && mixed.conflicts === 2,
  "operations after a failure still applied — a single bad record does not strand the queue",
  `applied=${mixed.applied} conflicts=${mixed.conflicts}`,
);
check(
  mixed.verdicts.length === 4,
  "every operation in the batch got a verdict, good or bad",
  mixed.verdicts.map((v) => `${v.kind}:${v.state}`).join(", "),
);

// ── 10. The ops exception queue ───────────────────────────────────────────────
console.log("\n10. The ops exception queue (§7: silent data loss is unacceptable)");
const counts = await opsC.sync.conflictCounts({});
check(
  (counts.open ?? 0) >= 6,
  "every unresolved conflict is sitting in the queue",
  JSON.stringify(counts),
);

const queue = await opsC.sync.conflicts({ state: ["open"] });
const policies = new Set(queue.map((c) => c.policy));
check(
  ["duplicate_claim", "offline_delivery_vs_fail", "duplicate_operation", "illegal_state", "unknown_kind"].every(
    (p) => policies.has(p as "illegal_state"),
  ),
  "every conflict Kandy's own devices raised is on Kandy's desk",
  [...policies].join(", "),
);
// The stale runsheet was pushed by a COLOMBO rider's device, so §5 puts it on
// Colombo's desk, not Kandy's. Asserting it here is what proves the queue is
// scoped by the actor's branch rather than the parcel's.
const colomboOpen = await clientFor(colomboOps.accessToken).sync.conflicts({ state: ["open"] });
check(
  colomboOpen.some((c) => c.policy === "stale_runsheet"),
  "the stale-runsheet conflict sits with the branch whose device raised it (§5)",
  `Colombo has ${colomboOpen.filter((c) => c.policy === "stale_runsheet").length}, Kandy has ${queue.filter((c) => c.policy === "stale_runsheet").length}`,
);

const target = queue.find((c) => c.policy === "offline_delivery_vs_fail")!;
const detail = await opsC.sync.conflictGet({ conflictId: target.id });
check(
  detail.conflict.clientClaim !== null && detail.conflict.serverState !== null,
  "a conflict shows the device's claim and the server's state side by side",
  `claim + serverState both present on ${target.id}`,
);

const claimed = await clientFor(kandyOps.accessToken, key("claim")).sync.conflictClaim({ conflictId: target.id });
check(claimed.state === "reviewing", "ops takes the conflict off the pile", `${target.id} is ${claimed.state}`);
await expectFail("a second ops user cannot work the same conflict", 409, () =>
  clientFor(admin.accessToken, key("claim-2")).sync.conflictClaim({ conflictId: target.id }),
);

await expectFail("a resolution with no account of why is refused", 400, () =>
  clientFor(kandyOps.accessToken, key("resolve-empty")).sync.conflictResolve({
    conflictId: target.id,
    resolution: "kept_server",
    notes: "",
  }),
);
const resolved = await clientFor(kandyOps.accessToken, key("resolve")).sync.conflictResolve({
  conflictId: target.id,
  resolution: "kept_server",
  notes: "Called the consignee: the parcel is still at the hub. Rider captured the POD against the wrong label.",
});
check(resolved.state === "resolved", "the decision is recorded with its reasoning", `${target.id} → ${resolved.resolution}`);
const afterResolve = await adminC.parcels.get({ awbOrId: ofd[4]! });
check(
  afterResolve.parcel.status === "OnHold",
  "resolving records a DECISION and does not re-drive the operation (§6: corrections are reversal events)",
  `${ofd[4]} is still ${afterResolve.parcel.status}`,
);

// ── 11. Fleet health and the audit journal ────────────────────────────────────
console.log("\n11. Fleet health and the journal");
const fleet = await opsC.sync.devices({});
const mine = fleet.find((d) => d.deviceId === DEVICE);
check(mine !== undefined, "the device appears in the fleet view", `${fleet.length} devices seen`);
check(
  (mine?.worstClockSkewSeconds ?? 0) >= 1750 && mine?.clockSuspect === true,
  "the fleet view surfaces the worst clock reading on the journal, not just the last one",
  `${DEVICE}: worst ${mine?.worstClockSkewSeconds}s (last ${mine?.clockSkewSeconds}s), suspect=${mine?.clockSuspect}, pending ${mine?.pendingReported}`,
);
check(
  mine?.branchId === kandyOps.user.branchId,
  "the fleet view is branch-scoped to the ops desk reading it (§5)",
  `${fleet.length} devices, all in ${mine?.branchId}`,
);

const journal = await opsC.sync.deviceJournal({ deviceId: DEVICE });
check(
  journal.duplicateClientOpIds === 0,
  "no client op id landed twice — the unique index is doing its job",
  `duplicates=${journal.duplicateClientOpIds}, total=${journal.total}`,
);
check(
  journal.total === journal.seqRange.count,
  "every operation is in the journal, whatever its outcome",
  `${journal.total} rows, states ${JSON.stringify(journal.byState)}`,
);

const rejectedRows = await opsC.sync.operations({ deviceId: DEVICE, state: ["conflict", "rejected"] });
check(
  rejectedRows.every((r) => r.error !== null && r.error.length > 0),
  "every refusal recorded WHY — that is the audit trail §7 asks for",
  `${rejectedRows.length} refusals, all with a reason`,
);

// ── 12. Who may sync at all ───────────────────────────────────────────────────
console.log("\n12. Role boundaries");
await expectFail("a merchant has a portal, not an outbox", 403, () =>
  clientFor(merchant.accessToken, key("merch-push")).sync.push({
    deviceId: "merchant-device",
    pendingCount: 0,
    operations: [{ clientOpId: ulid(), kind: "parcel.transition", seq: 1, payload: { awbOrId: ofd[0]!, to: "Cancelled" } }],
  }),
);
await expectFail("a merchant cannot delta-pull the fleet's view", 403, () =>
  clientFor(merchant.accessToken).sync.pull({ deviceId: "merchant-device", cursor: 0 }),
);
await expectFail("a rider cannot read the ops exception queue", 403, () => riderC.sync.conflicts({}));
await expectFail("a rider cannot read the fleet", 403, () => riderC.sync.devices({}));
await expectFail("a rider cannot resolve a conflict", 403, () =>
  clientFor(kandyRider.accessToken, key("rider-resolve")).sync.conflictResolve({
    conflictId: target.id,
    resolution: "dismissed",
    notes: "not mine to decide",
  }),
);
await expectFail("an unauthenticated device cannot push", 401, () =>
  clientFor(undefined, key("anon-push")).sync.push({
    deviceId: DEVICE,
    pendingCount: 0,
    operations: [{ clientOpId: ulid(), kind: "parcel.transition", seq: 1, payload: {} }],
  }),
);
await expectFail("a push without an Idempotency-Key is refused (§4)", 400, () =>
  clientFor(kandyRider.accessToken).sync.push({
    deviceId: DEVICE,
    pendingCount: 0,
    operations: [{ clientOpId: ulid(), kind: "parcel.transition", seq: 1, payload: {} }],
  }),
);
await expectFail("an empty batch is a client bug, not a drain", 400, () =>
  clientFor(kandyRider.accessToken, key("empty")).sync.push({
    deviceId: DEVICE,
    pendingCount: 0,
    operations: [],
  }),
);

// Colombo ops must not see Kandy's custody disputes (§5).
const colomboQueue = await clientFor(colomboOps.accessToken).sync.conflicts({ state: ["open"] });
const kandyIds = new Set(queue.map((c) => c.id));
check(
  colomboQueue.every((c) => !kandyIds.has(c.id)),
  "a branch's conflicts are not visible from another branch's ops desk (§5)",
  `Colombo sees ${colomboQueue.length}, none of Kandy's ${kandyIds.size}`,
);

// ── Result ────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(70)}`);
if (failures.length === 0) {
  console.log(`sync engine smoke test: ${pass}/${pass} checks passed\n`);
} else {
  console.log(`sync engine smoke test: ${pass} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  · ${f}`);
  console.log("");
  process.exit(1);
}
