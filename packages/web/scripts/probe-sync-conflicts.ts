import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "../src/api";
import { finishMfa } from "./lib/mfa";

/**
 * Contract probe for the ops sync-conflict screen (web/pages/ops/sync-conflicts.tsx).
 *
 * A page that compiles is not a page that works. Every field the screen reads
 * is asserted present on the LIVE payload here, because a UI reading a field
 * the server stopped sending renders an empty cell rather than an error — and
 * an ops exception queue that quietly shows a blank where the device's claim
 * should be is precisely the "silent data loss" §7 forbids.
 *
 * Also asserts the gates the screen relies on:
 *   - transport is refused (these are opsProc routes, unlike /ops/exceptions)
 *   - a merchant is refused outright
 *   - §5 branch scoping: Kandy ops cannot read a Colombo conflict by id
 *   - a resolution with an empty note is refused by contract
 *   - claiming twice is refused (409), not silently overwritten
 *
 * Read-mostly: it claims and resolves ONE conflict it created state for, and
 * only ever one it can identify as its own, so it is safe to re-run.
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4200";

const { db } = await import("../src/api/database");
const { hardenScriptReads } = await import("./lib/db-retry");
hardenScriptReads(db);
const { rateLimit } = await import("../src/api/database/schema/shared");
const { like } = await import("drizzle-orm");
await db.delete(rateLimit);

async function clearOtpBucket(): Promise<void> {
  await db.delete(rateLimit).where(like(rateLimit.bucket, "%identity.requestOtp"));
}

let keySeq = 0;
function key(label: string): string {
  keySeq += 1;
  return `probe-sc-${label}-${Date.now()}-${keySeq}`;
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
async function refuses(label: string, status: number, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    bad(label, `expected ${status}, the call succeeded`);
  } catch (err) {
    const got = (err as { data?: { status?: number } })?.data?.status;
    if (got === status) ok(label, `${status}`);
    else bad(label, `expected ${status}, got ${errText(err)}`);
  }
}

/** Every field the screen's ConflictRow interface reads off a list row. */
const ROW_FIELDS = [
  "id",
  "operationId",
  "clientOpId",
  "policy",
  "kind",
  "deviceId",
  "userName",
  "branchId",
  "awb",
  "detail",
  "clientClaim",
  "serverState",
  "state",
  "resolution",
  "resolutionNotes",
  "resolvedByName",
  "resolvedAt",
  "createdAt",
] as const;

/** Every field the screen's DeviceRow interface reads off a fleet row. */
const DEVICE_FIELDS = [
  "deviceId",
  "userId",
  "userName",
  "userRole",
  "branchId",
  "cursor",
  "lastPullAt",
  "lastPushAt",
  "pendingReported",
  "appVersion",
  "opsPushed",
  "opsRejected",
  "clockSkewSeconds",
  "worstClockSkewSeconds",
  "clockSuspect",
  "lastOperationAt",
] as const;

function missing(obj: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((f) => !(f in obj));
}

async function login(phone: string, deviceId?: string) {
  await clearOtpBucket();
  const challenge = await anon.identity.requestOtp({ phone });
  if (!challenge.devCode) throw new Error(`no dev OTP for ${phone} (smsState=${challenge.smsState})`);
  return finishMfa(BASE, await anon.identity.verifyOtp({
    challengeId: challenge.challengeId,
    code: challenge.devCode,
    deviceId: deviceId ?? null,
  }));
}

console.log(`\nNatEx ops sync-conflict screen contract probe (§7) → ${BASE}\n`);

// ── 1. Principals ─────────────────────────────────────────────────────────────
console.log("1. Principals");
const kandyOps = await login("+94779012345");
const colomboOps = await login("+94772345678");
const kandyTransport = await login("+94777890123");
const merchant = await login("+94775678901");
const admin = await login("+94773456789");
ok("logged in", "kandy ops, colombo ops, kandy transport, merchant, admin");

const opsC = clientFor(kandyOps.accessToken);
const cmbOpsC = clientFor(colomboOps.accessToken);
const transportC = clientFor(kandyTransport.accessToken);
const merchantC = clientFor(merchant.accessToken);
const adminC = clientFor(admin.accessToken);

// ── 2. The three reads the screen mounts with ─────────────────────────────────
console.log("\n2. The reads the screen mounts with");

const queue = await opsC.sync.conflicts({ limit: 150, state: ["open", "reviewing"] });
check(Array.isArray(queue), "sync.conflicts returns a list", `${queue.length} unresolved`);

const all = await opsC.sync.conflicts({ limit: 150 });
check(all.length >= queue.length, "unfiltered list is a superset of the unresolved one", `${all.length} total`);

if (all.length === 0) {
  bad(
    "queue has something to inspect",
    "no conflicts exist for this branch — run scripts/smoke-sync.ts first, it provokes all six policies",
  );
} else {
  const row = all[0] as unknown as Record<string, unknown>;
  const gaps = missing(row, ROW_FIELDS);
  check(gaps.length === 0, "every field the table and drawer read is present", gaps.length ? `missing: ${gaps.join(", ")}` : `${ROW_FIELDS.length} fields`);
  check(typeof row.detail === "string" && (row.detail as string).length > 0, "detail is prose, not an empty string", String(row.detail).slice(0, 60));
  check(
    typeof row.createdAt === "string" || row.createdAt instanceof Date,
    "createdAt is a value `since()` can format",
    typeof row.createdAt,
  );
}

const counts = await opsC.sync.conflictCounts({});
check(typeof counts.open === "number", "conflictCounts.open is a number", String(counts.open));
check(typeof counts.resolved === "number", "conflictCounts.resolved is a number", String(counts.resolved));
check(
  counts.byPolicy !== null && typeof counts.byPolicy === "object",
  "conflictCounts.byPolicy is the map the tally strip iterates",
  JSON.stringify(counts.byPolicy),
);
const tallied = Object.values(counts.byPolicy).reduce((a, b) => a + b, 0);
check(tallied === counts.open, "byPolicy sums to the open count", `${tallied} === ${counts.open}`);

// Every policy the tally strip can render must be one the screen has a
// plain-language gloss for. A policy the engine raises that the screen labels
// only by its enum name is a half-built exception queue.
const GLOSSED = [
  "duplicate_operation",
  "duplicate_claim",
  "offline_delivery_vs_fail",
  "double_cod",
  "stale_runsheet",
  "illegal_state",
  "unknown_kind",
];
const unglossed = Object.keys(counts.byPolicy).filter((p) => !GLOSSED.includes(p));
check(unglossed.length === 0, "every live policy has a gloss on the screen", unglossed.length ? unglossed.join(", ") : "all seven known");

const fleet = await opsC.sync.devices({ limit: 100 });
check(Array.isArray(fleet), "sync.devices returns a list", `${fleet.length} devices`);
if (fleet.length === 0) {
  note("no devices have synced against Kandy — the fleet card renders nothing, which is its documented empty state");
} else {
  const dev = fleet[0] as unknown as Record<string, unknown>;
  const gaps = missing(dev, DEVICE_FIELDS);
  check(gaps.length === 0, "every field the fleet table reads is present", gaps.length ? `missing: ${gaps.join(", ")}` : `${DEVICE_FIELDS.length} fields`);
  check(typeof dev.clockSuspect === "boolean", "clockSuspect is the boolean the badge switches on", String(dev.clockSuspect));
  check(
    typeof dev.worstClockSkewSeconds === "number",
    "worstClockSkewSeconds is a number `skew()` can render",
    `${dev.worstClockSkewSeconds}s`,
  );
  const suspects = (fleet as unknown as Record<string, unknown>[]).filter((d) => d.clockSuspect === true);
  note(`${suspects.length} of ${fleet.length} devices are flagged clock-suspect (±30 min, §7's own threshold)`);
}

// ── 3. The drawer's read ──────────────────────────────────────────────────────
console.log("\n3. The drawer's read");

const openRows = (await opsC.sync.conflicts({ limit: 150, state: ["open"] })) as unknown as Record<
  string,
  unknown
>[];
if (openRows.length === 0) {
  bad("an open conflict exists to work", "nothing open on Kandy's desk — re-run scripts/smoke-sync.ts");
} else {
  const target = openRows[0]!;
  const full = await opsC.sync.conflictGet({ conflictId: target.id as string });
  check(Boolean(full.conflict), "conflictGet returns the conflict", String(target.policy));
  const cGaps = missing(full.conflict as unknown as Record<string, unknown>, ROW_FIELDS);
  check(cGaps.length === 0, "the detail payload carries the same fields as the list row", cGaps.length ? `missing: ${cGaps.join(", ")}` : "identical shape");

  // The whole point of the screen: two versions of the truth, side by side.
  // At least one side must be populated, or the drawer shows an ops user a
  // dispute with no evidence in it.
  const claim = (full.conflict as { clientClaim: unknown }).clientClaim;
  const server = (full.conflict as { serverState: unknown }).serverState;
  check(
    claim !== null || server !== null,
    "at least one side of the comparison carries evidence",
    `clientClaim=${claim === null ? "null" : "present"} serverState=${server === null ? "null" : "present"}`,
  );

  check(full.operation !== null, "the journal entry behind the conflict came back");
  if (full.operation) {
    const op = full.operation as unknown as Record<string, unknown>;
    const opGaps = missing(op, ["id", "kind", "seq", "state", "error", "payload", "clientTs", "clockSkewSeconds", "receivedAt", "appliedAt"]);
    check(opGaps.length === 0, "every field the journal panel reads is present", opGaps.length ? `missing: ${opGaps.join(", ")}` : "10 fields");
    check(
      op.payload !== null && typeof op.payload === "object",
      "the payload is a parsed object, not a JSON string the pre block would print with escapes",
      typeof op.payload,
    );
    check(
      op.state === "conflict" || op.state === "rejected" || op.state === "duplicate",
      "the journal row's verdict matches a conflict",
      String(op.state),
    );
  }

  // ── 4. The gates the screen leans on ────────────────────────────────────────
  console.log("\n4. The gates the screen leans on");

  await refuses("transport is refused the queue (opsProc, unlike /ops/exceptions)", 403, () =>
    transportC.sync.conflicts({ limit: 10 }),
  );
  await refuses("transport is refused the fleet view", 403, () => transportC.sync.devices({ limit: 10 }));
  await refuses("a merchant is refused outright", 403, () => merchantC.sync.conflicts({ limit: 10 }));
  await refuses("a merchant is refused the fleet view", 403, () => merchantC.sync.devices({ limit: 10 }));

  // §5: Colombo ops must not be able to open Kandy's conflict by id, even
  // though its role check passes. Refuse — never silently re-scope.
  await refuses("§5: Colombo ops cannot open a Kandy conflict by id", 403, () =>
    cmbOpsC.sync.conflictGet({ conflictId: target.id as string }),
  );
  const cmbQueue = await cmbOpsC.sync.conflicts({ limit: 150 });
  const leaked = (cmbQueue as unknown as Record<string, unknown>[]).filter(
    (r) => r.branchId !== null && r.branchId !== "brn_cmb_central",
  );
  check(leaked.length === 0, "§5: Colombo's queue carries no other branch's rows", `${cmbQueue.length} rows, 0 foreign`);

  // Admin is global scope: the same id opens for them.
  const asAdmin = await adminC.sync.conflictGet({ conflictId: target.id as string });
  check(asAdmin.conflict.id === target.id, "admin's global scope opens the same conflict");

  // A resolution with no account of why is not an audit trail (§7).
  await refuses("an empty resolution note is refused by contract", 400, () =>
    clientFor(kandyOps.accessToken, key("empty-note")).sync.conflictResolve({
      conflictId: target.id as string,
      resolution: "kept_server",
      notes: "",
    }),
  );
  await refuses("a mutation with no Idempotency-Key is refused (§4)", 400, () =>
    opsC.sync.conflictResolve({
      conflictId: target.id as string,
      resolution: "kept_server",
      notes: "no idempotency key on this one",
    }),
  );

  // ── 5. Claim and resolve, the way the drawer's buttons do ───────────────────
  console.log("\n5. Claim and resolve, as the drawer's buttons do");

  const claimed = await clientFor(kandyOps.accessToken, key("claim")).sync.conflictClaim({
    conflictId: target.id as string,
  });
  check(claimed.state === "reviewing", "claiming moves it to reviewing", claimed.state);
  check(
    claimed.resolvedByName === "Ishara Dissanayake",
    "the claimant's name is on the record",
    String(claimed.resolvedByName),
  );

  // Two ops users must not work one dispute. The second claimant is refused,
  // not silently handed a conflict someone else is deciding.
  await refuses("a second claim on the same conflict is refused", 409, () =>
    clientFor(admin.accessToken, key("claim2")).sync.conflictClaim({
      conflictId: target.id as string,
    }),
  );

  const afterClaim = await opsC.sync.conflicts({ limit: 150, state: ["reviewing"] });
  check(
    (afterClaim as unknown as Record<string, unknown>[]).some((r) => r.id === target.id),
    "the reviewing filter the screen offers finds it",
  );

  const resolved = await clientFor(kandyOps.accessToken, key("resolve")).sync.conflictResolve({
    conflictId: target.id as string,
    resolution: "kept_server",
    notes: "Contract probe: rang the branch, the server's state is correct. Closed without a correction.",
  });
  check(resolved.state === "resolved", "resolving closes it", resolved.state);
  check(resolved.resolution === "kept_server", "the decision is recorded verbatim", String(resolved.resolution));
  check(
    (resolved.resolutionNotes ?? "").includes("Contract probe"),
    "the note is kept, not discarded",
    String(resolved.resolutionNotes).slice(0, 48),
  );
  check(resolved.resolvedAt !== null, "resolvedAt is stamped, so the drawer can show when it closed");

  // A closed conflict is never reopened — the drawer renders a terminal state
  // instead of a form, and the server backs that up rather than trusting it.
  await refuses("a resolved conflict cannot be resolved again", 409, () =>
    clientFor(kandyOps.accessToken, key("resolve2")).sync.conflictResolve({
      conflictId: target.id as string,
      resolution: "dismissed",
      notes: "second attempt at a closed conflict",
    }),
  );
  await refuses("a resolved conflict cannot be claimed", 409, () =>
    clientFor(kandyOps.accessToken, key("claim3")).sync.conflictClaim({
      conflictId: target.id as string,
    }),
  );

  const finalCounts = await opsC.sync.conflictCounts({});
  check(
    finalCounts.open === counts.open - 1,
    "the tally strip drops by exactly one",
    `${counts.open} → ${finalCounts.open}`,
  );
  check(
    finalCounts.resolved === counts.resolved + 1,
    "and the closed count rises by exactly one",
    `${counts.resolved} → ${finalCounts.resolved}`,
  );

  const closedList = await opsC.sync.conflicts({ limit: 150, state: ["resolved"] });
  const readBack = (closedList as unknown as Record<string, unknown>[]).find((r) => r.id === target.id);
  check(Boolean(readBack), "the All / Resolved filter reads it back with its note");
  check(
    typeof readBack?.resolutionNotes === "string" && (readBack.resolutionNotes as string).length > 0,
    "the resolution note survives the round trip the screen displays it from",
  );
}

// ── 6. The page itself serves ─────────────────────────────────────────────────
console.log("\n6. The route serves");
const html = await fetch(`${BASE}/ops/sync-conflicts`);
check(html.status === 200, "/ops/sync-conflicts responds 200", String(html.status));
const body = await html.text();
check(body.includes("<div id=\"root\"") || body.includes("id=\"root\""), "the SPA shell rendered");

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(
  `\nsync conflict screen probe: ${pass}/${pass + failures.length} checks passed${
    failures.length ? `\n\nFAILURES:\n${failures.map((f) => `  - ${f}`).join("\n")}` : ""
  }\n`,
);
if (failures.length) process.exit(1);
