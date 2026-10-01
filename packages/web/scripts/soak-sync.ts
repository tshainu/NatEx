import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "../src/api";
import { ulid } from "../src/api/shared/ulid";
import { CMB_BRANCH, railToKandyHub } from "./lib/rail";

/**
 * PROJECT.md §7's pre-pilot gate, run literally:
 *
 *   "500 sequential operations on a device in airplane mode, clock skewed ±30
 *    minutes, force-quit mid-queue three times, then reconnect. Every
 *    operation must land exactly once, in order, with a complete audit trail."
 *
 * Each clause is a mechanical step here, not an approximation:
 *
 *   airplane mode      the whole 500-entry outbox is built in memory BEFORE
 *                      anything is sent, so no operation can be influenced by
 *                      a server response — which is exactly what a phone in a
 *                      dead zone does.
 *   clock skewed       every clientTs is jittered ±30 minutes and is
 *                      deliberately NOT monotonic, and the reconnect pushes
 *                      alternate between a clock 30 minutes fast and 30
 *                      minutes slow. The work is a 5-step chain per parcel
 *                      that is only legal in seq order, so if the server ever
 *                      ordered by clock instead of by counter, the chains
 *                      would break and the run would fail.
 *   force-quit x3      at three points the drain re-pushes a chunk it already
 *                      sent, because a phone killed mid-drain never saw the
 *                      response and still holds those entries in its outbox.
 *   exactly once       500 journal rows, 500 distinct client op ids, 500
 *                      applied, and every replayed chunk answered `duplicate`
 *                      with the stored result rather than re-applying.
 *   in order           all 100 parcels end Delivered, which is only reachable
 *                      by walking the 5 steps in the device's own order.
 *   audit trail        every operation has a journal row, and every push has
 *                      an audit-log row; both are asserted against the DB.
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4200";
const PARCELS = 100;
const OPS_PER_PARCEL = 5;
const TOTAL = PARCELS * OPS_PER_PARCEL; // 500, per §7
const CHUNK = 25;
const CRASH_AFTER_CHUNKS = [4, 11, 17]; // three force-quits, spread through the drain
const DEVICE = `soak-${Date.now()}`; // a fresh install each run, so counts are this run's
const SKEW = 30 * 60_000; // §7's ±30 minutes

const { db } = await import("../src/api/database");
const { rateLimit, auditLog } = await import("../src/api/database/schema/shared");
const { syncOperation } = await import("../src/api/database/schema/sync");
const { and, eq, gte, sql } = await import("drizzle-orm");
await db.delete(rateLimit);

let keySeq = 0;
function key(label: string): string {
  keySeq += 1;
  return `soak-${label}-${Date.now()}-${keySeq}`;
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
function check(cond: boolean, label: string, detail = ""): void {
  if (cond) ok(label, detail);
  else {
    failures.push(`${label}: ${detail}`);
    console.log(`  FAIL  ${label} — ${detail}`);
  }
}

async function login(phone: string, deviceId?: string) {
  await db.delete(rateLimit);
  const challenge = await anon.identity.requestOtp({ phone });
  if (!challenge.devCode) throw new Error(`no dev OTP for ${phone}`);
  return anon.identity.verifyOtp({
    challengeId: challenge.challengeId,
    code: challenge.devCode,
    deviceId: deviceId ?? null,
  });
}

/** Runs promises with a bounded concurrency, so staging does not open 100 sockets. */
async function pooled<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const startedAt = Date.now();
console.log(`\nNatEx sync soak test — §7's 500-operation pre-pilot gate → ${BASE}`);
console.log(`device ${DEVICE}, ${TOTAL} operations over ${PARCELS} parcels\n`);

// ── 1. The crew ───────────────────────────────────────────────────────────────
// The soak runs on an OPS device: the chain below crosses OutForDelivery, which
// TRANSITION_ROLES reserves for ops/transport/admin, and the engine — not the
// role matrix — is what is being soaked. A rider's own drain is covered by
// smoke-sync.ts.
console.log("1. Staging");
const admin = await login("+94773456789");
const ops = await login("+94779012345", DEVICE);
const adminC = clientFor(admin.accessToken);
const opsC = clientFor(ops.accessToken);
ok("device signed in", `${ops.user.name} (${ops.user.role}) on ${DEVICE}`);

// ── 2. Stage 100 parcels at the doorstep ──────────────────────────────────────
// mch_ceylon_threads takes a SIGNATURE POD: an offline device cannot request a
// delivery OTP, so an OTP merchant's parcel is undeliverable from an outbox.
const booked = await pooled(Array.from({ length: PARCELS }, (_, i) => i), 8, async (i) => {
  const created = await clientFor(admin.accessToken, key(`book-${i}`)).parcels.create({
    merchantId: "mch_ceylon_threads",
    branchId: CMB_BRANCH,
    weightGrams: 900,
    declaredValueCents: 120_000,
    codAmountCents: 0,
    originAddress: "12 Dharmapala Mawatha, Kandy",
    consigneeName: `Soak Fixture ${i + 1}`,
    consigneePhone: "+94761112233",
    destAddress: `${i + 1} Katugastota Road, Kandy`,
  });
  return created.parcel.awb;
});
check(booked.length === PARCELS, `${PARCELS} parcels booked`, `${booked[0]} … ${booked[booked.length - 1]}`);

// Real custody chain — Bagged → InTransit needs a sealed bag on a trip (§6).
await railToKandyHub({ clientFor, login: (p) => login(p), adminToken: admin.accessToken, awbs: booked, key, label: "soak" });
const ofdRes = await clientFor(admin.accessToken, key("rail-OutForDelivery")).parcels.transitionMany({
  awbs: booked,
  to: "OutForDelivery",
  notes: "soak staging",
});
if (ofdRes.rejected.length > 0) throw new Error(`staging to OutForDelivery rejected ${JSON.stringify(ofdRes.rejected)}`);
ok("all of them railed to the doorstep", "Booked → … → OutForDelivery");

// ── 3. Build the outbox in airplane mode ──────────────────────────────────────
console.log("\n2. Airplane mode: 500 operations queued with no server in reach");
interface Entry {
  clientOpId: string;
  kind: string;
  seq: number;
  clientTs: number;
  payload: Record<string, unknown>;
}
const POD = { receivedByRelation: "self", method: "signature", signatureData: "data:image/png;base64,AAAA" };
const REASONS = ["CONSIGNEE_NOT_AT_HOME", "PREMISES_CLOSED", "CONSIGNEE_UNREACHABLE", "TIME_EXHAUSTED"];

const outbox: Entry[] = [];
const base = Date.now();
booked.forEach((awb, p) => {
  // Five steps, legal ONLY in this order. Two failed attempts and a delivery
  // is an ordinary bad afternoon on a Kandy run, and it exercises both
  // delivery kinds plus the transition kind against the same parcel.
  const steps: { kind: string; payload: Record<string, unknown> }[] = [
    { kind: "delivery.fail", payload: { awb, reasonCode: REASONS[p % REASONS.length]!, notes: "gate locked" } },
    { kind: "parcel.transition", payload: { awbOrId: awb, to: "OutForDelivery", notes: "re-attempt" } },
    { kind: "delivery.fail", payload: { awb, reasonCode: REASONS[(p + 1) % REASONS.length]!, notes: "still nobody" } },
    { kind: "parcel.transition", payload: { awbOrId: awb, to: "OutForDelivery", notes: "third run" } },
    { kind: "delivery.deliver", payload: { awb, receivedByName: `Soak Signer ${p + 1}`, ...POD } },
  ];
  steps.forEach((step, s) => {
    const seq = p * OPS_PER_PARCEL + s + 1;
    outbox.push({
      clientOpId: ulid(),
      kind: step.kind,
      seq,
      // ±30 min of jitter, deliberately NOT monotonic: sorting this queue by
      // clientTs would scramble every chain and the run would fail.
      clientTs: base + (((seq * 7919) % (2 * SKEW)) - SKEW),
      payload: step.payload,
    });
  });
});

check(outbox.length === TOTAL, `${TOTAL} operations in the outbox before the radio comes back`, `seq 1..${outbox[outbox.length - 1]!.seq}`);
check(new Set(outbox.map((o) => o.clientOpId)).size === TOTAL, "every entry carries its own ULID client id", "no id reused");
const tsOrder = outbox.map((o) => o.clientTs);
check(
  tsOrder.some((t, i) => i > 0 && t < tsOrder[i - 1]!),
  "the queue's clock readings run backwards in places — ordering by them would corrupt it",
  `min ${new Date(Math.min(...tsOrder)).toISOString()}, max ${new Date(Math.max(...tsOrder)).toISOString()}`,
);

// ── 4. The reconnect ──────────────────────────────────────────────────────────
console.log("\n3. Reconnect: draining in chunks, force-quitting three times");
const chunks: Entry[][] = [];
for (let i = 0; i < outbox.length; i += CHUNK) chunks.push(outbox.slice(i, i + CHUNK));

let applied = 0;
let duplicates = 0;
let rejected = 0;
let conflicts = 0;
const verdictFor = new Map<string, string>();
let crashes = 0;
let pushCalls = 0;

async function drain(entries: Entry[], label: string, skewSign: number) {
  pushCalls += 1;
  const res = await clientFor(ops.accessToken, key(label)).sync.push({
    deviceId: DEVICE,
    appVersion: "1.0.0-soak",
    // The device reports its own wall clock, 30 minutes out either way.
    clientNow: Date.now() + skewSign * SKEW,
    pendingCount: outbox.length - applied,
    operations: entries.map((e) => ({
      clientOpId: e.clientOpId,
      kind: e.kind,
      seq: e.seq,
      clientTs: e.clientTs,
      payload: e.payload,
    })),
  });
  for (const v of res.verdicts) if (!verdictFor.has(v.clientOpId)) verdictFor.set(v.clientOpId, v.state);
  return res;
}

for (let c = 0; c < chunks.length; c += 1) {
  const chunk = chunks[c]!;
  const skewSign = c % 2 === 0 ? 1 : -1;
  const res = await drain(chunk, `drain-${c}`, skewSign);
  applied += res.applied;
  duplicates += res.duplicates;
  rejected += res.rejected;
  conflicts += res.conflicts;

  if (CRASH_AFTER_CHUNKS.includes(c)) {
    // Force-quit: the app died before it could mark these as acknowledged, so
    // on restart the outbox still has all 25 and pushes them again — with a
    // fresh Idempotency-Key, because the header is per-request and the process
    // that made the old one is gone. Only the data-model dedupe can save this.
    crashes += 1;
    const replay = await drain(chunk, `crash-${crashes}`, -skewSign);
    duplicates += replay.duplicates;
    check(
      replay.applied === 0 && replay.duplicates === chunk.length,
      `force-quit ${crashes}: the re-pushed chunk was recognised, not re-applied`,
      `chunk ${c}: applied=${replay.applied} duplicates=${replay.duplicates}`,
    );
    check(
      replay.verdicts.every((v) => v.state === "duplicate" && v.result !== null),
      `force-quit ${crashes}: each replayed entry got its STORED result back`,
      `${replay.verdicts.length} verdicts, all duplicate with a result`,
    );
  }
}

check(crashes === 3, "the device was force-quit mid-queue three times, as §7 asks", `crashes at chunks ${CRASH_AFTER_CHUNKS.join(", ")}`);
console.log(
  `  ...  ${pushCalls} pushes in ${((Date.now() - startedAt) / 1000).toFixed(0)}s: applied=${applied} duplicates=${duplicates} rejected=${rejected} conflicts=${conflicts}`,
);

// ── 5. Exactly once ───────────────────────────────────────────────────────────
console.log("\n4. Exactly once");
check(applied === TOTAL, `all ${TOTAL} operations applied`, `applied=${applied}`);
check(rejected === 0 && conflicts === 0, "nothing was refused", `rejected=${rejected} conflicts=${conflicts}`);
check(
  duplicates === CRASH_AFTER_CHUNKS.length * CHUNK,
  "the only duplicates were the three force-quit replays",
  `${duplicates} duplicates, expected ${CRASH_AFTER_CHUNKS.length * CHUNK}`,
);
check(verdictFor.size === TOTAL, "every queued entry got a verdict", `${verdictFor.size} of ${TOTAL}`);

const journal = await opsC.sync.deviceJournal({ deviceId: DEVICE });
check(journal.total === TOTAL, `the journal holds exactly ${TOTAL} rows`, `total=${journal.total}, byState=${JSON.stringify(journal.byState)}`);
check(journal.duplicateClientOpIds === 0, "no client op id landed twice", `duplicates=${journal.duplicateClientOpIds}`);
check(
  journal.seqRange.count === TOTAL && journal.seqRange.min === 1 && journal.seqRange.max === TOTAL,
  "the journal's seq range is the device's own 1..500 with no gaps",
  JSON.stringify(journal.seqRange),
);

// Straight at the table, not through the API: 500 distinct client op ids.
const [distinct] = await db
  .select({ n: sql<number>`count(distinct ${syncOperation.clientOpId})` })
  .from(syncOperation)
  .where(eq(syncOperation.deviceId, DEVICE));
check(Number(distinct?.n ?? 0) === TOTAL, "the table agrees: 500 distinct client op ids", `${distinct?.n} distinct rows`);

// ── 6. In order ───────────────────────────────────────────────────────────────
console.log("\n5. In order");
const order = await opsC.sync.operationOrder({ deviceId: DEVICE, limit: 1000 });
check(order.length === TOTAL, "the journal reads back the whole run", `${order.length} rows`);
const seqs = order.map((r) => r.seq);
check(
  seqs.every((s, i) => s === i + 1),
  "and reads back in the device's own counter order, 1..500",
  `${seqs[0]}..${seqs[seqs.length - 1]}`,
);

const sampled = await pooled([0, 1, 37, 58, 99].map((i) => booked[i]!), 5, (awb) => adminC.parcels.get({ awbOrId: awb }));
check(
  sampled.every((p) => p.parcel.status === "Delivered"),
  "sampled parcels walked the whole 5-step chain and ended Delivered",
  sampled.map((p) => `${p.parcel.awb}:${p.parcel.status}`).join(", "),
);
const statuses = await pooled(booked, 10, (awb) => adminC.parcels.get({ awbOrId: awb }));
const notDelivered = statuses.filter((p) => p.parcel.status !== "Delivered");
check(
  notDelivered.length === 0,
  `all ${PARCELS} parcels ended Delivered — the chains held despite the skewed clocks`,
  notDelivered.length === 0 ? "none stranded" : notDelivered.map((p) => `${p.parcel.awb}:${p.parcel.status}`).join(", "),
);
const attempts = statuses.filter((p) => p.timeline.filter((e) => e.toStatus === "DeliveryAttempted").length === 2);
check(
  attempts.length === PARCELS,
  "each parcel records both failed attempts before the delivery — no step was swallowed",
  `${attempts.length} of ${PARCELS} parcels have exactly 2 attempts`,
);

// ── 7. A complete audit trail ─────────────────────────────────────────────────
console.log("\n6. A complete audit trail");
const rows = await opsC.sync.operations({ deviceId: DEVICE, limit: 500 });
check(rows.length === TOTAL, "every operation is readable from the ops side", `${rows.length} rows`);
check(
  rows.every((r) => r.state === "applied" && r.receivedAt !== null && r.appliedAt !== null),
  "each row records what happened and when the server applied it",
  `${rows.filter((r) => r.appliedAt !== null).length} rows carry an appliedAt`,
);
check(
  rows.every((r) => typeof r.clockSkewSeconds === "number" && Math.abs(r.clockSkewSeconds) >= SKEW / 1000 - 60),
  "each row keeps the clock reading it arrived with, so a skewed clientTs can be reinterpreted later",
  `skews seen: ${[...new Set(rows.map((r) => r.clockSkewSeconds))].slice(0, 4).join(", ")}s`,
);

const [audits] = await db
  .select({ n: sql<number>`count(*)` })
  .from(auditLog)
  .where(and(eq(auditLog.action, "sync.pushed"), gte(auditLog.ts, new Date(startedAt))));
check(
  Number(audits?.n ?? 0) >= pushCalls,
  "every push left an audit-log row (§4's audit middleware, not the sync module's own writing)",
  `${audits?.n} audit rows for ${pushCalls} pushes`,
);

const fleet = await opsC.sync.devices({ limit: 200 });
const mine = fleet.find((d) => d.deviceId === DEVICE);
check(mine !== undefined, "the device shows up in the ops fleet view", `${fleet.length} devices`);
check(
  (mine?.opsPushed ?? 0) >= TOTAL && Math.abs(mine?.worstClockSkewSeconds ?? 0) >= SKEW / 1000 - 60,
  "and ops can see both its volume and its bad clock",
  `pushed ${mine?.opsPushed}, worst skew ${mine?.worstClockSkewSeconds}s, suspect=${mine?.clockSuspect}`,
);

const conflictQueue = await opsC.sync.conflicts({ state: ["open"], limit: 200 });
check(
  conflictQueue.every((c) => !order.some((o) => o.clientOpId === c.clientOpId)),
  "a clean run puts nothing in the exception queue",
  `${conflictQueue.length} open conflicts, none from this device`,
);

// ── 8. And the device can reconcile afterwards ────────────────────────────────
const pull = await opsC.sync.pull({ deviceId: DEVICE, cursor: 0, limit: 200 });
check(pull.cursor > 0 && pull.parcels.length > 0, "the device can pull the server's authority back down", `cursor ${pull.cursor}, ${pull.parcels.length} parcels, hasMore=${pull.hasMore}`);

// ── Result ────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(70)}`);
const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
if (failures.length === 0) {
  console.log(`§7 soak gate: ${pass}/${pass} checks passed — ${TOTAL} operations, 3 force-quits, ±30 min skew, ${secs}s\n`);
} else {
  console.log(`§7 soak gate: ${pass} passed, ${failures.length} FAILED in ${secs}s\n`);
  for (const f of failures) console.log(`  · ${f}`);
  console.log("");
  process.exit(1);
}
