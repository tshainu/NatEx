import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { deriveOriginBranch, type AccountabilityMoveEvent } from "../src/api/modules/parcels/origin-branch";

type Target = "production" | "demo" | "local-test";
type Assignment = { parcelId: string; originBranchId: string; source: "first-transfer" | "current-branch" };

const args = process.argv.slice(2);
const target = args.find((arg) => arg.startsWith("--target="))?.slice("--target=".length) as Target | undefined;
const apply = args.includes("--apply");
const printFingerprint = args.includes("--print-database-fingerprint");
const expectedDatabaseFingerprint = args
  .find((arg) => arg.startsWith("--expected-database-sha256="))
  ?.slice("--expected-database-sha256=".length)
  .toLowerCase();
const expectedPlanHash = args
  .find((arg) => arg.startsWith("--expected-plan-sha256="))
  ?.slice("--expected-plan-sha256=".length)
  .toLowerCase();
const backupId = args.find((arg) => arg.startsWith("--backup-id="))?.slice("--backup-id=".length);
const knownArgs = new Set([
  "--apply",
  "--plan",
  "--print-database-fingerprint",
  "--confirm-production",
  "--confirm-demo",
  "--confirm-local-test",
  "--allow-unresolved",
  "--target=production",
  "--target=demo",
  "--target=local-test",
]);
const unknownArgs = args.filter(
  (arg) => !knownArgs.has(arg) &&
    !arg.startsWith("--expected-database-sha256=") &&
    !arg.startsWith("--expected-plan-sha256=") &&
    !arg.startsWith("--backup-id="),
);
if (unknownArgs.length) throw new Error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
if (!target || !["production", "demo", "local-test"].includes(target)) {
  throw new Error("Choose --target=production, --target=demo or --target=local-test.");
}
if (apply && args.includes("--plan")) throw new Error("Choose either --plan or --apply, not both.");
if (!apply && !args.includes("--plan") && !printFingerprint) {
  throw new Error("Default mode is read-only; pass --plan or --print-database-fingerprint.");
}
if (apply && printFingerprint) throw new Error("Fingerprint mode cannot be combined with --apply.");
if (apply && target === "production" && !args.includes("--confirm-production")) {
  throw new Error("Production apply requires --confirm-production.");
}
if (apply && target === "demo" && !args.includes("--confirm-demo")) {
  throw new Error("Demo apply requires --confirm-demo.");
}
if (apply && target === "local-test" && !args.includes("--confirm-local-test")) {
  throw new Error("Local apply requires --confirm-local-test.");
}
if (target !== "production" && args.includes("--confirm-production")) {
  throw new Error("--confirm-production is valid only for the Production target.");
}
if (target !== "demo" && args.includes("--confirm-demo")) {
  throw new Error("--confirm-demo is valid only for the Demo target.");
}
if (target !== "local-test" && args.includes("--confirm-local-test")) {
  throw new Error("--confirm-local-test is valid only for the local-test target.");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be set in the target environment.");
if (target === "local-test" && !databaseUrl.startsWith("file:")) {
  throw new Error("--target=local-test only accepts a file: SQLite DATABASE_URL.");
}
if (target !== "local-test" && databaseUrl.startsWith("file:")) {
  throw new Error("Production/Demo targets cannot use a file: SQLite DATABASE_URL.");
}

// Pinned Production hostname hash copied from the independently reviewed
// production cleanup utility. No URL or token is printed by this script.
const PRODUCTION_TURSO_HOST_SHA256 = "d557f5fff232c49aca934b135a4ea69ab3cded55ffe49fddc712810fb5e23051";
if (target !== "local-test") {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`--target=${target} requires a valid Turso DATABASE_URL.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "libsql:" || !host.endsWith(".turso.io")) {
    throw new Error("Production/Demo target requires a libsql:// Turso host.");
  }
  if (target === "production") {
    const hostHash = createHash("sha256").update(host).digest("hex");
    if (!host.includes("natex-prod-us") || host.includes("natex-demo-us") || hostHash !== PRODUCTION_TURSO_HOST_SHA256) {
      throw new Error("Production target refused: configured DB is not the pinned NatEx Production Turso host.");
    }
  } else if (!host.includes("natex-demo-us") || host.includes("natex-prod-us")) {
    throw new Error("Demo target refused: configured DB does not identify as the NatEx Demo Turso host.");
  }
}

const databaseFingerprint = createHash("sha256")
  .update(databaseUrl)
  .update("\0")
  .update(process.env.DATABASE_AUTH_TOKEN ?? "")
  .digest("hex");
if (printFingerprint) {
  if (apply) throw new Error("Cannot print a database fingerprint while applying.");
  console.log(JSON.stringify({ target, databaseFingerprint, databaseUrlPrinted: false }, null, 2));
  process.exit(0);
}
if (apply) {
  if (!expectedPlanHash || !/^[a-f0-9]{64}$/.test(expectedPlanHash)) {
    throw new Error("Apply requires --expected-plan-sha256=<reviewed dry-run plan hash>.");
  }
  if (!expectedDatabaseFingerprint || !/^[a-f0-9]{64}$/.test(expectedDatabaseFingerprint)) {
    throw new Error("Apply requires --expected-database-sha256=<verified target fingerprint>.");
  }
  if (expectedDatabaseFingerprint !== databaseFingerprint) {
    throw new Error("Configured database fingerprint does not match the independently reviewed target.");
  }
  if (target !== "local-test" && (!backupId || !/^[A-Za-z0-9._-]{1,120}$/.test(backupId))) {
    throw new Error("Production/Demo apply requires --backup-id=<verified durable backup identifier>.");
  }
}

interface ParcelRow {
  id: string;
  branch_id: string | null;
  origin_branch_id: string | null;
}
interface EventRow {
  id: string;
  parcel_id: string;
  ts: number | bigint | string;
  notes: string | null;
}
interface PlanSummary {
  target: Target;
  databaseFingerprint: string;
  schemaHasOriginBranchId: boolean;
  totalParcels: number;
  alreadySet: number;
  validMovementBackfill: number;
  unchangedCurrentBranchBackfill: number;
  unresolved: Record<string, number>;
  assignments: Assignment[];
  planSha256: string;
}

const client = createClient({ url: databaseUrl, authToken: process.env.DATABASE_AUTH_TOKEN });

async function planBackfill(): Promise<PlanSummary> {
  const parcelColumns = await client.execute('PRAGMA table_info("parcels_parcel")');
  if (parcelColumns.rows.length === 0) throw new Error("The parcels_parcel table is unavailable on this target.");
  const schemaHasOriginBranchId = parcelColumns.rows.some((row) => String(row.name) === "origin_branch_id");
  const parcelQuery = schemaHasOriginBranchId
    ? "SELECT id, branch_id, origin_branch_id FROM parcels_parcel ORDER BY id"
    : "SELECT id, branch_id, NULL AS origin_branch_id FROM parcels_parcel ORDER BY id";
  const [parcelsResult, eventsResult, branchResult] = await Promise.all([
    client.execute(parcelQuery),
    client.execute(`SELECT id, parcel_id, ts, notes FROM parcels_parcel_event
      WHERE notes LIKE '%Accountability moved from%' ORDER BY ts, id`),
    client.execute("SELECT id FROM identity_branch"),
  ]);
  const validBranchIds = new Set(branchResult.rows.map((row) => String(row.id)));
  const eventsByParcel = new Map<string, AccountabilityMoveEvent[]>();
  const eventRows = eventsResult.rows as unknown as EventRow[];
  for (const event of eventRows) {
    const parcelId = String(event.parcel_id);
    const list = eventsByParcel.get(parcelId) ?? [];
    list.push({ id: String(event.id), ts: event.ts, notes: event.notes === null ? null : String(event.notes) });
    eventsByParcel.set(parcelId, list);
  }

  const assignments: Assignment[] = [];
  const unresolved: Record<string, number> = {};
  let alreadySet = 0;
  let validMovementBackfill = 0;
  let unchangedCurrentBranchBackfill = 0;
  const rows = parcelsResult.rows as unknown as ParcelRow[];
  for (const row of rows) {
    const existing = row.origin_branch_id === null ? null : String(row.origin_branch_id);
    if (existing) {
      if (validBranchIds.has(existing)) alreadySet += 1;
      else unresolved["existing-origin-not-in-branch-table"] = (unresolved["existing-origin-not-in-branch-table"] ?? 0) + 1;
      continue;
    }

    const derived = deriveOriginBranch(
      row.branch_id === null ? null : String(row.branch_id),
      eventsByParcel.get(String(row.id)) ?? [],
    );
    if (!derived.originBranchId) {
      unresolved[derived.source] = (unresolved[derived.source] ?? 0) + 1;
      continue;
    }
    if (!validBranchIds.has(derived.originBranchId)) {
      unresolved["derived-origin-not-in-branch-table"] = (unresolved["derived-origin-not-in-branch-table"] ?? 0) + 1;
      continue;
    }
    assignments.push({
      parcelId: String(row.id),
      originBranchId: derived.originBranchId,
      source: derived.source as Assignment["source"],
    });
    if (derived.source === "first-transfer") validMovementBackfill += 1;
    if (derived.source === "current-branch") unchangedCurrentBranchBackfill += 1;
  }

  assignments.sort((a, b) => a.parcelId.localeCompare(b.parcelId));
  const planPayload = {
    target,
    databaseFingerprint,
    schemaHasOriginBranchId,
    assignments,
    unresolved,
    alreadySet,
  };
  return {
    target: target!,
    databaseFingerprint,
    schemaHasOriginBranchId,
    totalParcels: rows.length,
    alreadySet,
    validMovementBackfill,
    unchangedCurrentBranchBackfill,
    unresolved,
    assignments,
    planSha256: createHash("sha256").update(JSON.stringify(planPayload)).digest("hex"),
  };
}

async function main() {
  try {
    const plan = await planBackfill();
    if (apply) {
      if (!plan.schemaHasOriginBranchId) {
        throw new Error("origin_branch_id is not present. Apply the approved schema change first.");
      }
      if (plan.planSha256 !== expectedPlanHash) {
        throw new Error("The live data no longer matches the reviewed plan hash; re-run --plan before applying.");
      }
      if (Object.values(plan.unresolved).some((count) => count > 0) && !args.includes("--allow-unresolved")) {
        throw new Error("The plan contains unresolved history. Review it, then explicitly pass --allow-unresolved to backfill only proven rows.");
      }
      const CHUNK_SIZE = 200;
      for (let start = 0; start < plan.assignments.length; start += CHUNK_SIZE) {
        const chunk = plan.assignments.slice(start, start + CHUNK_SIZE);
        const statements = chunk.map((assignment) => ({
          sql: "UPDATE parcels_parcel SET origin_branch_id = ? WHERE id = ? AND origin_branch_id IS NULL",
          args: [assignment.originBranchId, assignment.parcelId],
        }));
        await client.batch(statements, "write");
      }
      const remaining = await client.execute("SELECT COUNT(*) AS count FROM parcels_parcel WHERE origin_branch_id IS NULL");
      const assigned = await client.execute("SELECT COUNT(*) AS count FROM parcels_parcel WHERE origin_branch_id IS NOT NULL");
      console.log(JSON.stringify({
        result: "applied",
        target,
        backupId: target === "local-test" ? null : backupId,
        assignedRows: plan.assignments.length,
        unresolvedFromReviewedPlan: Object.values(plan.unresolved).reduce((sum, value) => sum + value, 0),
        currentNullRows: Number(remaining.rows[0]?.count ?? 0),
        currentAssignedRows: Number(assigned.rows[0]?.count ?? 0),
        planSha256: plan.planSha256,
      }, null, 2));
      return;
    }

    const { assignments: _assignments, ...safeSummary } = plan;
    console.log(JSON.stringify({
      ...safeSummary,
      assignmentsToBackfill: plan.assignments.length,
      assignmentsBySource: {
        firstTransfer: plan.validMovementBackfill,
        currentBranchNoTransferEvent: plan.unchangedCurrentBranchBackfill,
      },
      planSha256: plan.planSha256,
      recordDetailsPrinted: false,
    }, null, 2));
  } finally {
    client.close();
  }
}

await main();
