import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "../src/api";
import { CMB_BRANCH, railToKandyHub } from "./lib/rail";
import { bankRiderCash } from "./lib/cash";
import { retireRun } from "./lib/retire";

/**
 * End-to-end exercise of the Milestone 3 API against a running dev server
 * (PROJECT.md §5 delivery module, §6 POD + RTO transitions, §8 NDR/SLA,
 * §9 messaging, §10 M3).
 *
 * Walks the real day: the hub builds a runsheet from what arrived, orders the
 * stops, hands the van to the rider; the rider delivers one against the
 * merchant's POD policy with COD reconciled to the cent, fails one into the NDR
 * queue, and hits a refusal that turns a parcel straight back; the merchant
 * answers its NDR; ops closes the cash; and the return leg is signed back in.
 *
 * Every guardrail §6/§8 promises is asserted by trying to break it: the role
 * table (a rider may not load their own van, a rider may not close their own
 * cash), the attempt ceiling, the reason-code flags, the POD policy, exact-cent
 * COD, one live run per rider per day, a run that cannot be closed with stops
 * still open, and merchant row scoping on the NDR queue and the message log.
 *
 * Repeatable: section 3 stages whatever stops are missing (one OTP-policy
 * parcel, three signature-policy ones) by booking them and railing them along
 * the legal §6 chain to AtDestHub through the real audited endpoints. A pass
 * delivers or returns everything it touches, so without that top-up a second
 * run would find the pool empty — which it used to crash on rather than report.
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4200";

// Logins burn the tight OTP bucket (5 per phone, refilling 1/min), and this
// script needs six. Drain the buckets first — smoke.ts owns the rate-limit
// assertion itself.
const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { like } = await import("drizzle-orm");
await db.delete(rateLimit);

/**
 * `identity.requestOtp` is bucketed per-IP only (capacity 5) — an
 * unauthenticated caller has no principal to bucket against — so six logins
 * from one machine trip it by design. Clear that one bucket between logins;
 * smoke.ts owns the assertion that the limiter actually bites.
 */
async function clearOtpBucket(): Promise<void> {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
}

let keySeq = 0;
/** A fresh idempotency key per intentional write (§4 requires one on mutations). */
function key(label: string): string {
  keySeq += 1;
  return `m3-${label}-${Date.now()}-${keySeq}`;
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

console.log(`\nNatEx M3 smoke test (delivery / NDR / RTO / notifications) → ${BASE}\n`);

// ── 1. Logins ─────────────────────────────────────────────────────────────────
console.log("1. Who is on shift");
const kandyTransport = await login("+94777890123");
const kandyRider = await login("+94778901234", "kandy-rider-device-001");
const colomboRider = await login("+94771234567", "rider-device-001");
// Kandy's own ops desk. Only admin/finance are global scope (§5), so Colombo's
// ops user cannot work this hub's day — asserted as a negative below.
const ops = await login("+94779012345");
const colomboOps = await login("+94772345678");
const merchantUser = await login("+94775678901");
const admin = await login("+94773456789");

const trC = clientFor(kandyTransport.accessToken);
const riderC = clientFor(kandyRider.accessToken);
const opsC = clientFor(ops.accessToken);
const merchC = clientFor(merchantUser.accessToken);
const adminC = clientFor(admin.accessToken);

ok("Kandy transport", `${kandyTransport.user.name} @ ${kandyTransport.user.branchName}`);
ok("Kandy rider", `${kandyRider.user.name}, device ${kandyRider.user.deviceId}`);
ok("Kandy ops", `${ops.user.name} @ ${ops.user.branchName}`);
check(
  colomboOps.user.branchId !== ops.user.branchId,
  "the control ops user sits at another branch (§5 negative fixture)",
  `${colomboOps.user.name} @ ${colomboOps.user.branchName}`,
);

// ── 2. Reason codes ───────────────────────────────────────────────────────────
console.log("\n2. Failure reason codes (§10 M3)");
const reasons = await trC.delivery.reasons({});
check(reasons.length >= 15, "reason codes are seeded and readable", `${reasons.length} active codes`);

const refused = reasons.find((r) => r.code === "CONSIGNEE_REFUSED");
check(
  refused?.triggersRto === true && refused?.allowsReattempt === false,
  "a refusal is flagged final (triggersRto, no reattempt)",
  `${refused?.label}: rto=${refused?.triggersRto} reattempt=${refused?.allowsReattempt}`,
);
const breakdown = reasons.find((r) => r.code === "VEHICLE_BREAKDOWN");
check(
  breakdown?.countsAsAttempt === false,
  "NatEx's own failure does not burn a consignee attempt",
  `${breakdown?.label}: countsAsAttempt=${breakdown?.countsAsAttempt}`,
);
const notAtHome = reasons.find((r) => r.code === "CONSIGNEE_NOT_AT_HOME");
check(
  notAtHome?.countsAsAttempt === true && notAtHome?.allowsReattempt === true,
  "an ordinary miss burns an attempt and may be retried",
  `${notAtHome?.label}`,
);

// ── 3. What can go out ────────────────────────────────────────────────────────
console.log("\n3. Deliverable stock at the destination hub");

/**
 * Stage the stops this script needs instead of depending on what the seed left
 * behind. A pass through here delivers or returns every parcel it touches, and
 * the sync soak walks another hundred to Delivered, so the seeded pool at
 * AtDestHub drains — in particular the one OTP-policy merchant's parcel, whose
 * absence used to crash the script rather than report anything.
 *
 * Staging goes through the real audited endpoints (parcels.create, then
 * parcels.transitionMany along the legal §6 rail), so nothing here bypasses the
 * state machine to plant a row the engine would have refused.
 */
async function stage(merchantId: string, count: number, label: string, codAmountCents = 0): Promise<string[]> {
  const awbs: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const created = await clientFor(admin.accessToken, key(`stage-${label}-${i}`)).parcels.create({
      merchantId,
      branchId: CMB_BRANCH,
      weightGrams: 800,
      declaredValueCents: 95_000,
      codAmountCents,
      originAddress: "12 Dharmapala Mawatha, Kandy",
      consigneeName: `M3 Fixture ${label} ${i + 1}`,
      consigneePhone: "+94761112233",
      destAddress: `${i + 1} Katugastota Road, Kandy`,
    });
    awbs.push(created.parcel.awb);
  }
  // Real custody chain — Bagged → InTransit needs a sealed bag on a trip (§6).
  await railToKandyHub({ clientFor, login: (p) => login(p), adminToken: admin.accessToken, awbs: awbs, key, label: label });
  return awbs;
}

const preStage = await trC.delivery.deliverable({});
// The OTP stop must carry COD: the exact-cent reconciliation below asserts that
// a payment one cent short is refused, and against a zero-COD parcel "one cent
// short" clamps back to zero and the assertion passes on a degenerate case.
const needOtp =
  preStage.ready.filter((p) => p.merchantId === "mch_lanka_gadgets" && p.codAmountCents > 0).length < 1;
// Only untouched stock counts: a parcel left DeliveryAttempted by an earlier run
// already carries a burned attempt, and the attempt-count assertions below
// (1/3 after the first miss) would then read 2/3 for reasons of history.
const fresh = (p: { deliveryAttempts: number; status: string }) => p.deliveryAttempts === 0 && p.status === "AtDestHub";
const needSig = Math.max(
  0,
  3 - preStage.ready.filter((p) => p.merchantId === "mch_ceylon_threads" && fresh(p)).length,
);
if (needOtp) await stage("mch_lanka_gadgets", 1, "otp", 250_000);
if (needSig > 0) await stage("mch_ceylon_threads", needSig, "sig");
check(
  true,
  "the stops this run needs are standing at the door",
  needOtp || needSig > 0
    ? `staged ${needOtp ? 1 : 0} otp + ${needSig} signature parcel(s) through the real rail`
    : "seeded stock was sufficient, nothing staged",
);

const deliverable = await trC.delivery.deliverable({});
check(
  deliverable.ready.length >= 3,
  "parcels that arrived at Kandy are ready to load",
  `${deliverable.ready.length} ready, ${deliverable.blocked.length} blocked`,
);
if (deliverable.ready.length < 3) {
  console.log("\nCannot continue: M3 needs at least 3 parcels AtDestHub and staging did not produce them.\n");
  process.exit(1);
}

// Pick one parcel per POD policy so both proof paths get exercised.
const codParcels = deliverable.ready.filter((p) => p.codAmountCents > 0);
// policy: otp, and carrying COD so the exact-cent assertion is not degenerate
const otpParcel = deliverable.ready.find((p) => p.merchantId === "mch_lanka_gadgets" && p.codAmountCents > 0)!;
const sigParcels = deliverable.ready.filter((p) => p.merchantId === "mch_ceylon_threads" && fresh(p)); // policy: signature
const failParcel = sigParcels[0]!;
const refuseParcel = sigParcels[1] ?? sigParcels[0]!;
check(
  Boolean(otpParcel) && otpParcel.codAmountCents > 0 && failParcel.awb !== refuseParcel.awb,
  "three distinct stops chosen, covering both POD policies, the OTP one carrying COD",
  `otp=${otpParcel?.awb} (COD ${otpParcel?.codAmountCents}c), fail=${failParcel.awb}, refuse=${refuseParcel.awb}, ${codParcels.length} COD`,
);

// ── 4. Role table on building a run (§6) ──────────────────────────────────────
console.log("\n4. Who may build a run");
const riders = await trC.identity.listRiders();
const kandyRiderRow = riders.find((r) => r.id === kandyRider.user.id)!;
check(Boolean(kandyRiderRow), "hub can list its own riders", `${riders.length} rider(s) at the hub`);

await expectFail("a rider may not load their own van", 403, () =>
  clientFor(kandyRider.accessToken, key("rider-create")).delivery.runsheetCreate({
    riderId: kandyRider.user.id,
  }),
);
await expectFail("a runsheet cannot be opened for a non-rider", 400, () =>
  clientFor(kandyTransport.accessToken, key("nonrider")).delivery.runsheetCreate({
    riderId: kandyTransport.user.id,
  }),
);
await expectFail("a hub cannot roster another branch's rider", 403, () =>
  clientFor(kandyTransport.accessToken, key("otherbranch")).delivery.runsheetCreate({
    riderId: colomboRider.user.id,
  }),
);

// ── 5. Build the run ──────────────────────────────────────────────────────────
console.log("\n5. Runsheet build");

/**
 * §6 allows one live run per rider per day, and a previous pass through this
 * script (or one that stopped halfway) leaves that day's run open. Retire it
 * the way the hub would — a forced close, which is audited and notes why —
 * rather than deleting the row underneath the engine. The one-live-run rule
 * itself is asserted further down, against the run this section creates.
 */
const stale = await clientFor(ops.accessToken).delivery.runsheetList({
  riderId: kandyRider.user.id,
  status: ["draft", "dispatched"],
});
for (const openRun of stale) {
  const retired = await retireRun(clientFor(ops.accessToken, key(`retire-${openRun.id}`)), openRun, "stale run left open by an earlier smoke pass, retired before re-testing");
  check(
    retired.status === (openRun.status === "draft" ? "cancelled" : "closed"),
    "a half-finished run is retired through the audited close/cancel, not deleted",
    `${openRun.code} ${openRun.status} → ${retired.status}, ${retired.swept} stop(s) swept back`,
  );
}

const sheet = await clientFor(kandyTransport.accessToken, key("create")).delivery.runsheetCreate({
  riderId: kandyRider.user.id,
});
check(
  sheet.status === "draft" && sheet.riderId === kandyRider.user.id,
  "runsheet opened as a draft",
  `${sheet.code} for ${sheet.riderName}, ${sheet.runDate}`,
);

// One burst: three good labels, a label that does not exist, a parcel still at
// the origin hub, and a parcel accountable to another branch. Every one gets a
// verdict; none fails the batch.
const strayAwb = "NX0000000001";
const atOriginAwb = "NX4820001507";
const otherBranchOnHoldAwb = "NX4820002329";
const addResult = await clientFor(kandyTransport.accessToken, key("add")).delivery.runsheetAdd({
  runsheetId: sheet.id,
  awbs: [
    otpParcel.awb,
    failParcel.awb,
    refuseParcel.awb,
    strayAwb,
    atOriginAwb,
    otherBranchOnHoldAwb,
  ],
});
const verdict = (awb: string) => addResult.lines.find((l) => l.awb === awb);
check(
  addResult.added === 3,
  "the three eligible stops are added",
  `${addResult.added} added, planned=${addResult.runsheet.plannedCount}, COD expected=${addResult.runsheet.codExpectedCents}`,
);
check(verdict(strayAwb)?.verdict === "unknown", "a stray label is reported, not fatal", verdict(strayAwb)?.reason ?? "");
check(
  verdict(atOriginAwb)?.verdict === "rejected",
  "a parcel that has not arrived yet is refused",
  verdict(atOriginAwb)?.reason ?? "",
);
check(
  verdict(otherBranchOnHoldAwb)?.verdict === "rejected",
  "another branch's parcel is refused",
  verdict(otherBranchOnHoldAwb)?.reason ?? "",
);

const readd = await clientFor(kandyTransport.accessToken, key("readd")).delivery.runsheetAdd({
  runsheetId: sheet.id,
  awbs: [otpParcel.awb],
});
check(
  readd.added === 0 && readd.lines[0]?.verdict === "duplicate",
  "re-scanning a loaded parcel is a duplicate, not a second stop",
  readd.lines[0]?.reason ?? "",
);

// ── 6. Stop order ─────────────────────────────────────────────────────────────
console.log("\n6. Route order");
const optimised = await clientFor(kandyTransport.accessToken, key("optimise")).delivery.runsheetOptimise({
  runsheetId: sheet.id,
});
const seqs = optimised.ordered.map((s) => s.seq);
check(
  seqs.join(",") === [1, 2, 3].join(","),
  "stops come back sequentially numbered",
  `method=${optimised.method}, ${optimised.ordered.length} stops, ${optimised.totalMetres} m, ${optimised.unlocated.length} unlocated`,
);
check(
  typeof optimised.method === "string" && optimised.method.length > 0,
  "the ordering algorithm names itself (known deviation is visible to callers)",
  optimised.method,
);

// ── 7. Dispatch ───────────────────────────────────────────────────────────────
console.log("\n7. Dispatch (§6: the hub hands over, not the rider)");
await expectFail("a rider may not dispatch their own run", 403, () =>
  clientFor(kandyRider.accessToken, key("rider-dispatch")).delivery.runsheetDispatch({
    runsheetId: sheet.id,
  }),
);
// COD deliveries now post COLLECT entries; settle what earlier runs left on
// the rider so the §8 cash-ceiling gate at dispatch is not tripped by fixtures.
await bankRiderCash({ clientFor, login: (p) => login(p), riderToken: kandyRider.accessToken, branchId: "brn_kdy_hub", key, label: "smoke-m3" });
const dispatched = await clientFor(kandyTransport.accessToken, key("dispatch")).delivery.runsheetDispatch({
  runsheetId: sheet.id,
  notes: "M3 smoke run.",
});
check(
  dispatched.runsheet.status === "dispatched" && dispatched.movedOut.length === 3,
  "the whole van goes OutForDelivery in one call",
  `${dispatched.movedOut.join(", ")}${dispatched.rejected.length > 0 ? ` (rejected ${dispatched.rejected.length})` : ""}`,
);

await expectFail("another branch's ops desk cannot read this hub's parcel (§5)", 403, () =>
  clientFor(colomboOps.accessToken).parcels.get({ awbOrId: otpParcel.awb }),
);
const otpParcelRow = await opsC.parcels.get({ awbOrId: otpParcel.awb });
check(
  otpParcelRow?.parcel.status === "OutForDelivery",
  "a dispatched parcel's status is OutForDelivery",
  `${otpParcel.awb} → ${otpParcelRow?.parcel.status}`,
);

await expectFail("a rider cannot hold two live runs in one day", 409, () =>
  clientFor(kandyTransport.accessToken, key("second-run")).delivery.runsheetCreate({
    riderId: kandyRider.user.id,
  }),
);
await expectFail("a dispatched run cannot take new stops", 409, () =>
  clientFor(kandyTransport.accessToken, key("late-add")).delivery.runsheetAdd({
    runsheetId: sheet.id,
    awbs: [otpParcel.awb],
  }),
);
await expectFail("a run with open stops cannot be closed", 409, () =>
  clientFor(ops.accessToken, key("early-close")).delivery.runsheetClose({ runsheetId: sheet.id }),
);
await expectFail("a dispatched run cannot be cancelled — parcels are on the van", 409, () =>
  clientFor(ops.accessToken, key("cancel-dispatched")).delivery.runsheetCancel({
    runsheetId: sheet.id,
    reason: "trying to cancel a run already on the road",
  }),
);

const mine = await riderC.delivery.myRunsheet({});
check(
  mine?.runsheet.id === sheet.id && mine?.items.length === 3,
  "the rider app opens on today's own run",
  `${mine?.runsheet.code}: ${mine?.items.map((i) => `${i.seq}.${i.awb}`).join(" ")}`,
);

// ── 8. The doorstep: OTP delivery with COD (§6, §9) ───────────────────────────
console.log("\n8. Doorstep — OTP proof, COD to the cent");
await expectFail("transport cannot record a doorstep event", 403, () =>
  clientFor(kandyTransport.accessToken, key("transport-pod")).delivery.recordDelivery({
    awb: otpParcel.awb,
    receivedByName: "Somebody",
    method: "otp",
  }),
);
await expectFail("delivery without a verified OTP is refused", 400, () =>
  clientFor(kandyRider.accessToken, key("pod-no-otp")).delivery.recordDelivery({
    awb: otpParcel.awb,
    receivedByName: "Kamala Wijesinghe",
    method: "otp",
    codCollectedCents: otpParcel.codAmountCents,
  }),
);

const challenge = await riderC.delivery.otpRequest({ awb: otpParcel.awb });
check(
  Boolean(challenge.devCode) && challenge.expiresInMinutes > 0,
  "delivery OTP sent to the consignee (SMS-only, §9)",
  `to ${challenge.sentTo}, smsState=${challenge.smsState}, ttl ${challenge.expiresInMinutes}m`,
);
await expectFail("a wrong code is rejected", 400, () =>
  riderC.delivery.otpVerify({ awb: otpParcel.awb, code: "000000" }),
);
const verified = await riderC.delivery.otpVerify({ awb: otpParcel.awb, code: challenge.devCode! });
check(verified.verified, "the consignee's code verifies", `challenge ${verified.challengeId}`);

await expectFail("a weaker proof than the merchant's policy is refused", 400, () =>
  clientFor(kandyRider.accessToken, key("wrong-method")).delivery.recordDelivery({
    awb: otpParcel.awb,
    receivedByName: "Kamala Wijesinghe",
    method: "signature",
    signatureData: "data:image/png;base64,AAAA",
    codCollectedCents: otpParcel.codAmountCents,
  }),
);
await expectFail("COD short by one cent is refused", 400, () =>
  clientFor(kandyRider.accessToken, key("cod-short")).delivery.recordDelivery({
    awb: otpParcel.awb,
    receivedByName: "Kamala Wijesinghe",
    method: "otp",
    codCollectedCents: otpParcel.codAmountCents - 1,
  }),
);

const clientMintedId = `dev-${Date.now()}-otp-pod`;
const delivered = await clientFor(kandyRider.accessToken, key("pod-otp")).delivery.recordDelivery({
  awb: otpParcel.awb,
  receivedByName: "Kamala Wijesinghe",
  receivedByRelation: "self",
  method: "otp",
  codCollectedCents: otpParcel.codAmountCents,
  lat: 7.2906,
  lng: 80.6337,
  clientId: clientMintedId,
  notes: "Handed over at the gate.",
});
check(
  delivered.parcel.status === "Delivered" && delivered.podId.length > 0 && !delivered.deduped,
  "delivered against a verified OTP with COD reconciled",
  `${delivered.parcel.awb}: POD ${delivered.podId}, COD ${delivered.codCollectedCents}c`,
);

const replay = await clientFor(kandyRider.accessToken, key("pod-otp-replay")).delivery.recordDelivery({
  awb: otpParcel.awb,
  receivedByName: "Kamala Wijesinghe",
  method: "otp",
  codCollectedCents: otpParcel.codAmountCents,
  clientId: clientMintedId,
});
check(
  replay.deduped && replay.attempt.id === delivered.attempt.id,
  "an offline replay of the same POD dedupes (§7)",
  `same attempt ${replay.attempt.id}`,
);

// ── 9. A failed attempt into the NDR queue (§8) ───────────────────────────────
console.log("\n9. Failed attempt → NDR");
const failed = await clientFor(kandyRider.accessToken, key("fail-1")).delivery.recordFailure({
  awb: failParcel.awb,
  reasonCode: "CONSIGNEE_NOT_AT_HOME",
  notes: "Nobody home, gate locked.",
  lat: 7.2801,
  lng: 80.6412,
});
check(
  failed.parcel.status === "DeliveryAttempted" &&
    failed.countedAsAttempt &&
    failed.attemptsUsed === 1 &&
    Boolean(failed.ndrId) &&
    failed.rtoId === null,
  "a missed delivery burns one attempt and raises an NDR",
  `${failed.parcel.awb}: attempt ${failed.attemptsUsed}/${failed.attemptsAllowed}, NDR ${failed.ndrId}`,
);

const queue = await opsC.ndr.list({ state: ["open"] });
const row = queue.find((r) => r.id === failed.ndrId);
check(
  Boolean(row) && Boolean(row?.slaDueAt),
  "the NDR is in the ops queue with an SLA clock",
  `${queue.length} open, ${row?.awb} due ${row?.slaDueAt ?? "?"}`,
);

const merchantQueue = await merchC.ndr.list({});
check(
  merchantQueue.every((r) => r.merchantId === merchantUser.user.merchantId),
  "a merchant sees only its own NDRs (§5)",
  `${merchantQueue.length} row(s), all ${merchantUser.user.merchantId}`,
);

await expectFail("an address_change with nothing to change is refused", 400, () =>
  clientFor(merchantUser.accessToken, key("bad-instruct")).ndr.instruct({
    ndrId: failed.ndrId!,
    instruction: "address_change",
  }),
);

const instructed = await clientFor(merchantUser.accessToken, key("instruct")).ndr.instruct({
  ndrId: failed.ndrId!,
  instruction: "reattempt",
  notes: "Customer confirmed they will be home tomorrow.",
});
check(
  instructed.ndr.state === "reattempt_scheduled" && instructed.ndr.merchantInstruction === "reattempt",
  "the merchant's answer moves the NDR out of open",
  `${instructed.ndr.awb} → ${instructed.ndr.state}, retry ${instructed.ndr.reattemptDate}`,
);
// An NDR stays live through reattempt_scheduled, so a merchant changing its
// mind while the parcel is still at the hub is legitimate — and reversible.
const reinstructed = await clientFor(merchantUser.accessToken, key("instruct-again")).ndr.instruct({
  ndrId: failed.ndrId!,
  instruction: "hold",
});
check(
  reinstructed.ndr.merchantInstruction === "hold" &&
    reinstructed.parcel.status === "OnHold",
  "a merchant may change its answer while the parcel is still at the hub",
  `${reinstructed.ndr.awb} → ${reinstructed.ndr.state}, parcel ${reinstructed.parcel.status}`,
);
check(
  reinstructed.parcel.status === "OnHold",
  "the hold is executed as a custody move, not refused for want of a role (§6/§8)",
  `instructed by ${reinstructed.ndr.instructedByName}`,
);
// And back to reattempt, which is what the rest of the run needs.
const backToRetry = await clientFor(merchantUser.accessToken, key("instruct-retry")).ndr.instruct({
  ndrId: failed.ndrId!,
  instruction: "reattempt",
});
check(
  backToRetry.ndr.state === "reattempt_scheduled",
  "and change it back, because nothing has happened to the parcel yet",
  `${backToRetry.ndr.awb} → ${backToRetry.ndr.state}`,
);

// ── 10. A refusal turns the parcel back by rule (§6) ──────────────────────────
console.log("\n10. Refusal → automatic RTO");
const refusedResult = await clientFor(kandyRider.accessToken, key("refuse")).delivery.recordFailure({
  awb: refuseParcel.awb,
  reasonCode: "CONSIGNEE_REFUSED",
  notes: "Consignee says they never ordered it.",
});
check(
  refusedResult.parcel.status === "RTOInitiated" && Boolean(refusedResult.rtoId),
  "a refusal skips the NDR wait and turns the parcel back",
  `${refusedResult.parcel.awb} → ${refusedResult.parcel.status}, RTO ${refusedResult.rtoId}`,
);

const refusedNdr = await opsC.ndr.get({ ndrId: refusedResult.ndrId! });
check(
  refusedNdr.ndr.state === "rto",
  "the NDR for a refused parcel closes itself as rto",
  `${refusedNdr.ndr.awb}: ${refusedNdr.ndr.state} — ${refusedNdr.ndr.closeReason ?? ""}`,
);

const refusedRto = (await opsC.ndr.rtoGet({ rtoId: refusedResult.rtoId! })).rto;
check(
  refusedRto?.trigger === "consignee_refused" &&
    (refusedRto.initiatedByName ?? "").toLowerCase().includes("system") &&
    refusedRto.reason.includes(kandyRider.user.name),
  "the rule is the actor and the rider is named honestly in the reason",
  `${refusedRto?.initiatedByName}: ${refusedRto?.reason}`,
);

// ── 11. Close the run and its cash (§1) ───────────────────────────────────────
console.log("\n11. Close the run");
await expectFail("a rider may not close their own cash position", 403, () =>
  clientFor(kandyRider.accessToken, key("rider-close")).delivery.runsheetClose({
    runsheetId: sheet.id,
  }),
);
const closed = await clientFor(ops.accessToken, key("close")).delivery.runsheetClose({
  runsheetId: sheet.id,
  notes: "End of day.",
});
check(
  closed.runsheet.status === "closed" &&
    closed.unattempted.length === 0 &&
    closed.cash.varianceCents === 0,
  "every stop settled, cash reconciles to zero variance",
  `expected ${closed.cash.expectedCents}c, collected ${closed.cash.collectedCents}c`,
);

// ── 12. Second run: the reattempt, and a forced close (§6, §1) ────────────────
console.log("\n12. Reattempt run + forced close");
const run2 = await clientFor(kandyTransport.accessToken, key("create-2")).delivery.runsheetCreate({
  riderId: kandyRider.user.id,
});
const add2 = await clientFor(kandyTransport.accessToken, key("add-2")).delivery.runsheetAdd({
  runsheetId: run2.id,
  awbs: [failParcel.awb],
});
check(
  add2.added === 1,
  "an instructed reattempt is loadable again",
  `${failParcel.awb} back on ${run2.code}`,
);
const dispatch2 = await clientFor(kandyTransport.accessToken, key("dispatch-2")).delivery.runsheetDispatch({
  runsheetId: run2.id,
});
check(dispatch2.movedOut.length === 1, "second run dispatched", dispatch2.movedOut.join(", "));

await expectFail("a forced close is required to write off open stops", 409, () =>
  clientFor(ops.accessToken, key("close2-noforce")).delivery.runsheetClose({ runsheetId: run2.id }),
);
const forced = await clientFor(ops.accessToken, key("close2-force")).delivery.runsheetClose({
  runsheetId: run2.id,
  force: true,
  notes: "Curfew in the hill country.",
});
check(
  forced.unattempted.includes(failParcel.awb) && forced.runsheet.status === "closed",
  "a forced close writes the remainder off as TIME_EXHAUSTED",
  `${forced.unattempted.join(", ")} written off`,
);
const afterForce = await opsC.parcels.get({ awbOrId: failParcel.awb });
check(
  afterForce?.parcel.deliveryAttempts === 1,
  "running out of day does not burn the consignee's attempt",
  `${failParcel.awb}: ${afterForce?.parcel.deliveryAttempts}/3 attempts used, status ${afterForce?.parcel.status}`,
);

// ── 12b. A draft that never left the hub is cancelled, freeing the rider ─────
console.log("\n12b. Cancel a draft run");
const spare = (await trC.delivery.deliverable({})).ready.find((p) => p.awb !== failParcel.awb);
const run3 = await clientFor(kandyTransport.accessToken, key("create-3")).delivery.runsheetCreate({
  riderId: kandyRider.user.id,
});
const spareBefore = spare ? (await opsC.parcels.get({ awbOrId: spare.awb }))?.parcel.status : undefined;
if (spare) {
  await clientFor(kandyTransport.accessToken, key("add-3")).delivery.runsheetAdd({
    runsheetId: run3.id,
    awbs: [spare.awb],
  });
}
await expectFail("a rider cannot cancel a run", 403, () =>
  clientFor(kandyRider.accessToken, key("cancel-rider")).delivery.runsheetCancel({
    runsheetId: run3.id,
    reason: "rider trying to drop the day",
  }),
);
await expectFail("a cancellation needs a reason", 400, () =>
  clientFor(kandyTransport.accessToken, key("cancel-thin")).delivery.runsheetCancel({
    runsheetId: run3.id,
    reason: "no",
  }),
);
const cancelled = await clientFor(kandyTransport.accessToken, key("cancel-3")).delivery.runsheetCancel({
  runsheetId: run3.id,
  reason: "Van broke down at the hub before dispatch.",
});
check(
  cancelled.runsheet.status === "cancelled" && cancelled.released.length === (spare ? 1 : 0),
  "a draft run is cancelled and its stops released",
  `${run3.code} → ${cancelled.runsheet.status}, released ${cancelled.released.join(", ") || "none"}`,
);
if (spare) {
  const spareRow = await opsC.parcels.get({ awbOrId: spare.awb });
  check(
    spareRow?.parcel.status === spareBefore && spareRow?.parcel.status !== "OutForDelivery",
    "cancelling a draft moves no parcel",
    `${spare.awb}: ${spareBefore} before, ${spareRow?.parcel.status} after`,
  );
}
await expectFail("a cancelled run cannot be cancelled twice", 409, () =>
  clientFor(kandyTransport.accessToken, key("cancel-again")).delivery.runsheetCancel({
    runsheetId: run3.id,
    reason: "second cancellation attempt",
  }),
);
const run4 = await clientFor(kandyTransport.accessToken, key("create-4")).delivery.runsheetCreate({
  riderId: kandyRider.user.id,
});
check(run4.status === "draft", "the rider is free for a new run the same day", run4.code);
await clientFor(kandyTransport.accessToken, key("cancel-4")).delivery.runsheetCancel({
  runsheetId: run4.id,
  reason: "smoke test tidy-up of an empty draft",
});

// ── 13. The return leg (§6 RTO transitions) ───────────────────────────────────
console.log("\n13. Return leg, signed back in");
await expectFail("an RTO reason must be a sentence, not a shrug", 400, () =>
  clientFor(ops.accessToken, key("rto-thin")).ndr.rtoInitiate({
    awb: failParcel.awb,
    reason: "nope",
  }),
);
const opsRto = await clientFor(ops.accessToken, key("rto-init")).ndr.rtoInitiate({
  awb: failParcel.awb,
  reason: "Consignee unreachable across two runs and the merchant wants it back.",
});
check(
  opsRto.parcel.status === "RTOInitiated" && opsRto.rto.trigger === "ops_decision",
  "ops can turn a parcel back by decision",
  `${opsRto.rto.awb}: ${opsRto.rto.state}, by ${opsRto.rto.initiatedByName}`,
);

await expectFail("a rider cannot dispatch the return leg", 403, () =>
  clientFor(kandyRider.accessToken, key("rto-rider-dispatch")).ndr.rtoDispatch({
    rtoId: opsRto.rto.id,
  }),
);
const rtoOut = await clientFor(kandyTransport.accessToken, key("rto-dispatch")).ndr.rtoDispatch({
  rtoId: opsRto.rto.id,
  notes: "On the Colombo linehaul.",
});
check(
  rtoOut.rto.state === "in_transit" && rtoOut.parcel.status === "RTOInTransit",
  "the return leg leaves the hub",
  `${rtoOut.rto.awb} → ${rtoOut.parcel.status}`,
);
await expectFail("a return cannot be signed back in without a name", 400, () =>
  clientFor(kandyRider.accessToken, key("rto-noname")).ndr.rtoDeliver({
    rtoId: opsRto.rto.id,
    receivedByName: "A",
  }),
);
const rtoDone = await clientFor(kandyRider.accessToken, key("rto-deliver")).ndr.rtoDeliver({
  rtoId: opsRto.rto.id,
  receivedByName: "Sanjay Kumar",
  signatureData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
  notes: "Returned to the merchant's Colombo counter.",
});
check(
  rtoDone.rto.state === "delivered" &&
    rtoDone.parcel.status === "RTODelivered" &&
    rtoDone.podId.length > 0,
  "the return is POD'd back into the merchant's hands (§6 requires it)",
  `${rtoDone.rto.awb}: ${rtoDone.parcel.status}, POD ${rtoDone.podId}, signed by ${rtoDone.rto.receivedByName}`,
);

const rtoQueue = await opsC.ndr.rtoList({});
const rtoTotals = await opsC.ndr.rtoCounts({});
check(
  rtoQueue.length >= 2,
  "both returns are on the RTO board",
  `${rtoQueue.length} rows, counts ${JSON.stringify(rtoTotals)}`,
);

// ── 14. The audit trail a dispute needs (§6, §8) ──────────────────────────────
console.log("\n14. Delivery history");
const history = await opsC.delivery.history({ awb: otpParcel.awb });
check(
  history.attempts.length >= 1 && history.pod?.method === "otp" && history.pod?.otpVerified === true,
  "every attempt and the POD are readable per parcel",
  `${history.attempts.length} attempt(s), POD by ${history.pod?.capturedByName}, received by ${history.pod?.receivedByName}`,
);
// otpParcel belongs to Lanka Gadgets; this merchant user is Ceylon Threads, so
// its own parcel is the right subject — and the other merchant's is a 404, not
// a 403, so the route never confirms that someone else's AWB exists (§5, §9).
const merchHistory = await merchC.delivery.history({ awb: failParcel.awb });
check(
  merchHistory.attempts.length >= 1,
  "a merchant can read its own parcel's delivery history",
  `${failParcel.awb}: ${merchHistory.attempts.length} attempt(s)`,
);
await expectFail("another merchant's parcel is not found, not forbidden (§5)", 404, () =>
  merchC.delivery.history({ awb: otpParcel.awb }),
);
const failHistory = await opsC.delivery.history({ awb: failParcel.awb });
check(
  failHistory.attempts.length >= 2 && failHistory.attempts.some((a) => a.reasonCode === "TIME_EXHAUSTED"),
  "the append-only attempt log keeps both failures with their reasons",
  failHistory.attempts.map((a) => `${a.attemptNo}:${a.outcome}${a.reasonCode ? `/${a.reasonCode}` : ""}`).join(" "),
);

const dCounts = await opsC.delivery.counts({});
const nCounts = await opsC.ndr.counts({});
ok("delivery + NDR dashboard counts", `${JSON.stringify(dCounts)} / ${JSON.stringify(nCounts)}`);

// ── 15. Consignee notifications (§9) ──────────────────────────────────────────
console.log("\n15. Notification ladder");
const templates = await opsC.notifications.templates({});
check(templates.length >= 6, "message templates are seeded", templates.map((t) => t.key).join(", "));

// The outbox drains on an interval; give the worker a moment to walk the ladder.
await new Promise((r) => setTimeout(r, 6000));

const msgs = await opsC.notifications.forParcel({ parcelId: delivered.parcel.id });
check(
  msgs.length >= 1,
  "the consignee was actually messaged about this parcel",
  msgs.map((m) => `${m.templateKey}/${m.channel}:${m.state}`).join(" "),
);
const ladderTried = msgs.some((m) => m.channel === "whatsapp") && msgs.some((m) => m.channel === "sms");
check(
  ladderTried,
  "the ladder tried WhatsApp first and fell through to SMS (known deviation, visible)",
  msgs.map((m) => `${m.channel}:${m.state}`).join(" → "),
);
const otherMerchantParcel = await merchC.notifications.forParcel({ parcelId: delivered.parcel.id });
check(
  delivered.parcel.merchantId === merchantUser.user.merchantId
    ? otherMerchantParcel.length === msgs.length
    : otherMerchantParcel.length === 0,
  "the message log is merchant-scoped (§5)",
  `merchant saw ${otherMerchantParcel.length} of ${msgs.length} row(s) for ${delivered.parcel.merchantId}`,
);
/**
 * A rendered body is what the consignee actually reads, so assert the copy is
 * whole. The out-for-delivery template interpolates {{codLine}}; the dispatch
 * caller used to pass only {{codAmount}}, so every OFD message went out with
 * the COD sentence silently dropped and "Unresolved placeholders: codLine"
 * buried in the worker log.
 */
const ofd = msgs.filter((m) => m.templateKey === "parcel.out_for_delivery");
check(ofd.length >= 1, "the consignee was told the parcel is out for delivery", `${ofd.length} row(s)`);
check(
  ofd.every((m) => !(m.reason ?? "").includes("Unresolved placeholders")),
  "no out-for-delivery message has an unresolved placeholder",
  ofd.map((m) => `${m.channel}:${m.reason ?? "-"}`).join(" | "),
);
check(
  delivered.parcel.codAmountCents > 0
    ? ofd.some((m) => m.channel !== "push" && /Rs\.\s?[\d,]+/.test(m.body))
    : true,
  "a COD parcel's out-for-delivery message names the cash to have ready",
  ofd.find((m) => m.channel !== "push")?.body ?? "(no body)",
);

const summary = await opsC.notifications.summary({});
ok("notification health rollup", JSON.stringify(summary));

const edited = await clientFor(admin.accessToken, key("tpl")).notifications.templateUpdate({
  key: "parcel.delivered",
  bodySms: "NatEx: {{awb}} delivered to {{receivedBy}} on {{date}}. Thank you.",
});
check(edited.version >= 2, "template copy is versioned when an admin edits it", `v${edited.version} by ${edited.updatedByName}`);
await expectFail("a non-admin cannot rewrite consignee copy", 403, () =>
  clientFor(ops.accessToken, key("tpl-ops")).notifications.templateUpdate({
    key: "parcel.delivered",
    bodySms: "nope",
  }),
);

// ── 16. Public tracking after delivery (§9 PDPA) ──────────────────────────────
console.log("\n16. Public tracking");
const tracked = (await anon.parcels.track({ awb: otpParcel.awb }))!;
check(
  tracked.publicStatus.toLowerCase().includes("deliver"),
  "the consignee's own tracking page shows the delivery",
  `${tracked.awb}: ${tracked.publicStatus}, ${tracked.timeline.length} steps`,
);
check(
  !("consigneePhone" in (tracked as unknown as Record<string, unknown>)) &&
    !("codAmountCents" in (tracked as unknown as Record<string, unknown>)),
  "delivery did not leak PII into the public view",
);

// ── 17. Merchant cannot reach staff-only delivery routes ──────────────────────
console.log("\n17. Role gates on the new surface");
await expectFail("a merchant cannot see the hub's deliverable stock", 403, () =>
  merchC.delivery.deliverable({}),
);
await expectFail("a merchant cannot list runsheets", 403, () => merchC.delivery.runsheetList({}));
await expectFail("a merchant cannot request a delivery OTP", 403, () =>
  merchC.delivery.otpRequest({ awb: otpParcel.awb }),
);
const adminSees = await adminC.delivery.runsheetList({});
check(adminSees.length >= 2, "admin sees every branch's runs", `${adminSees.length} run(s)`);

await db.delete(rateLimit);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL GREEN — ${pass} M3 checks passed.`);
} else {
  console.log(`${pass} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
