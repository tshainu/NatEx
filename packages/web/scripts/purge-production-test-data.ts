import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { prefixedId } from "../src/api/shared/ulid";

/**
 * One-time, operator-invoked cleanup. A live apply is Production-only, requires
 * a restore-verified backup, explicit owner approval, target fingerprint, and
 * reviewed plan hash. local-test mode accepts only file: SQLite.
 */
const DELETE_TABLES = [
  // COD/finance joins and workflow references before their ledger/document parents.
  "cod_invoice_line",
  "cod_settlement_line",
  "cod_deposit_item",
  "cod_ops_alert",
  "cod_hold",
  "cod_dispute",
  "cod_credit_note",
  "cod_entry",
  "cod_invariant_run",
  "cod_invoice",
  "cod_settlement",
  "cod_deposit",
  // Collection requests can reference manifests; remove them before manifest parents.
  "collection_manifest_item",
  "collection_pickup_request",
  "collection_manifest",
  // Attempts reference PODs/runsheet items; PODs may reference delivery OTPs.
  "delivery_attempt",
  "delivery_runsheet_item",
  "delivery_runsheet",
  "delivery_pod",
  "delivery_otp",
  "delivery_ndr",
  "delivery_rto",
  // Freight reconciliation and entries reference charges.
  "freight_reconciliation",
  "freight_entry",
  "freight_charge",
  // Transport and offline-sync rows can reference parcels, bags, or trips.
  "transport_bag_item",
  "transport_exception",
  "transport_hub_scan",
  "transport_bag",
  "transport_trip",
  "sync_conflict",
  "sync_operation",
  "sync_device_cursor",
  // HR transaction records; salary packages, employee records and assignments are preserved.
  "hr_payroll_line",
  "hr_leave_request",
  "hr_leave_adjustment",
  "hr_timesheet",
  "hr_payroll_run",
  // Sign-in challenges and refresh sessions are temporary; MFA setup remains.
  "identity_refresh_token",
  "identity_otp_challenge",
  // Parcel history is deleted only after every dependent operational row above.
  "parcels_parcel_event",
  "parcels_parcel",
  // Customer notification history/outbox and replay/cache rows.
  "notify_message",
  "shared_outbox",
  "shared_idempotency_key",
  "shared_rate_limit",
] as const;

const PRESERVE_TABLES = [
  "identity_branch",
  "identity_user",
  "identity_mfa_factor",
  "identity_mfa_recovery_code",
  "merchants_merchant",
  "merchants_rate_card",
  "merchants_rate_card_version",
  "merchants_rate_band",
  "merchants_rate_slab",
  "merchants_rate_surcharge",
  "parcels_awb_batch",
  "parcels_awb_batch_label",
  "parcels_awb_batch_series",
  "shared_audit_log",
  "hr_employee",
  "hr_employee_document",
  "hr_salary_package",
  "hr_salary_package_item",
  "hr_employee_package",
  "hr_leave_type",
  "hr_apit_schedule",
  "notify_template",
  "cod_finance_config",
  "cod_merchant_payout",
  "delivery_reason_code",
  "settings_value",
  "routing_zone",
  "routing_geocode_cache",
] as const;

const args = process.argv.slice(2);
const targetArg = args.find((arg) => arg.startsWith("--target="));
const target = targetArg?.slice("--target=".length);
const allowed = new Set([
  "--target=production",
  "--target=local-test",
  "--plan",
  "--apply",
  "--confirm-production-clear",
  "--confirm-local-test",
  "--print-database-fingerprint",
]);
const unknown = args.filter(
  (arg) => !allowed.has(arg) &&
    !arg.startsWith("--expected-database-sha256=") &&
    !arg.startsWith("--expected-plan-sha256="),
);
if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
if (target !== "production" && target !== "local-test") {
  throw new Error("Choose --target=production or --target=local-test.");
}
const apply = args.includes("--apply");
if (apply && args.includes("--plan")) throw new Error("Choose either --plan or --apply, not both.");
if (!apply && !args.includes("--plan") && !args.includes("--print-database-fingerprint")) {
  throw new Error("Default mode is explicit read-only planning; pass --plan.");
}
if (apply && target === "production" && !args.includes("--confirm-production-clear")) {
  throw new Error("Live apply requires --confirm-production-clear.");
}
if (apply && target === "local-test" && !args.includes("--confirm-local-test")) {
  throw new Error("Local apply requires --confirm-local-test.");
}
if (target !== "production" && args.includes("--confirm-production-clear")) {
  throw new Error("--confirm-production-clear is valid only with --target=production.");
}
if (target !== "local-test" && args.includes("--confirm-local-test")) {
  throw new Error("--confirm-local-test is valid only with --target=local-test.");
}
const expectedDatabaseFingerprint = args
  .find((arg) => arg.startsWith("--expected-database-sha256="))
  ?.slice("--expected-database-sha256=".length)
  .toLowerCase();
const expectedPlanHash = args
  .find((arg) => arg.startsWith("--expected-plan-sha256="))
  ?.slice("--expected-plan-sha256=".length)
  .toLowerCase();

const databaseUrl = process.env.DATABASE_URL;
// SHA-256 of the Production Turso hostname only; it is an allowlist, not a credential.
const PRODUCTION_TURSO_HOST_SHA256 = "d557f5fff232c49aca934b135a4ea69ab3cded55ffe49fddc712810fb5e23051";
if (!databaseUrl) throw new Error("DATABASE_URL must be set in the target environment.");
if (target === "local-test" && !databaseUrl.startsWith("file:")) {
  throw new Error("--target=local-test only accepts a file: SQLite DATABASE_URL.");
}
if (target === "production") {
  let databaseHost = "";
  let databaseProtocol = "";
  try {
    const parsed = new URL(databaseUrl);
    databaseHost = parsed.hostname.toLowerCase();
    databaseProtocol = parsed.protocol;
  } catch {
    throw new Error("--target=production requires a valid Production Turso DATABASE_URL.");
  }
  const hostFingerprint = createHash("sha256").update(databaseHost).digest("hex");
  if (databaseProtocol !== "libsql:" || !databaseHost.endsWith(".turso.io") ||
      !databaseHost.includes("natex-prod-us") || databaseHost.includes("natex-demo-us") ||
      hostFingerprint !== PRODUCTION_TURSO_HOST_SHA256) {
    throw new Error("--target=production accepts only the pinned Production Turso host; Demo and other databases are refused.");
  }
}
const databaseFingerprint = createHash("sha256")
  .update(databaseUrl)
  .update("\0")
  .update(process.env.DATABASE_AUTH_TOKEN ?? "")
  .digest("hex");
if (args.includes("--print-database-fingerprint")) {
  if (apply) throw new Error("Cannot print a fingerprint while applying.");
  console.log(JSON.stringify({ target, databaseFingerprint, databaseUrlPrinted: false }, null, 2));
  process.exit(0);
}
if (apply) {
  if (!expectedPlanHash || !/^[a-f0-9]{64}$/.test(expectedPlanHash)) {
    throw new Error("Apply requires --expected-plan-sha256=<reviewed dry-run plan hash>.");
  }
  if (target === "production") {
    if (!expectedDatabaseFingerprint || !/^[a-f0-9]{64}$/.test(expectedDatabaseFingerprint)) {
      throw new Error("Live apply requires --expected-database-sha256=<verified Production fingerprint>.");
    }
    if (expectedDatabaseFingerprint !== databaseFingerprint) {
      throw new Error("Configured database fingerprint does not match the independently verified Production target.");
    }
  } else if (expectedDatabaseFingerprint && expectedDatabaseFingerprint !== databaseFingerprint) {
    throw new Error("Local test database fingerprint does not match the reviewed target.");
  }
}

const client = createClient({ url: databaseUrl, authToken: process.env.DATABASE_AUTH_TOKEN });
type Executor = Pick<typeof client, "execute">;
type CountMap = Record<string, number>;
type HashMap = Record<string, string>;
type Target = "production" | "local-test";
const EMPTY_ROWS_SHA256 = createHash("sha256").update("[]").digest("hex");

async function count(conn: Executor, table: string, where = ""): Promise<number> {
  const result = await conn.execute(`SELECT COUNT(*) AS count FROM "${table}" ${where}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function countMap(conn: Executor, tables: readonly string[]): Promise<CountMap> {
  const pairs = await Promise.all(tables.map(async (table) => [table, await count(conn, table)] as const));
  return Object.fromEntries(pairs);
}

async function queryContentHash(conn: Executor, sql: string, args: unknown[] = []): Promise<string> {
  const result = await conn.execute({ sql, args } as never);
  const rows = result.rows.map((row) => result.columns.map((column) => {
    const value = row[column];
    return value instanceof Uint8Array ? Array.from(value) : value ?? null;
  }));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function tableContentHash(conn: Executor, table: string, where = "", args: unknown[] = []): Promise<string> {
  return queryContentHash(conn, `SELECT * FROM "${table}" ${where} ORDER BY rowid`, args);
}

async function contentHashMap(conn: Executor, tables: readonly string[], counts: CountMap): Promise<HashMap> {
  const hashes: Array<readonly [string, string]> = [];
  for (const table of tables) {
    hashes.push([table, counts[table] === 0 ? EMPTY_ROWS_SHA256 : await tableContentHash(conn, table)]);
  }
  return Object.fromEntries(hashes);
}

interface Plan {
  target: Target;
  databaseFingerprint: string;
  deleteCounts: CountMap;
  deleteContentSha256: HashMap;
  nonOtpSmsRows: number;
  nonOtpSmsContentSha256: string;
  otpSmsRowsBefore: number;
  otpSmsContentSha256: string;
  parcelStatuses: CountMap;
  parcelTrackingNumberCount: number;
  existingRetiredTrackingNumberCount: number;
  newRetiredTrackingNumberCount: number;
  existingRetiredTrackingNumberContentSha256: string;
  preservedCounts: CountMap;
  preservedContentSha256: HashMap;
  deletionTotal: number;
  planSha256: string;
}

async function planFor(conn: Executor): Promise<Plan> {
  const [deleteCounts, nonOtpSmsRows, otpSmsRowsBefore, parcelNumbers, existingRetiredTrackingNumberCount, preservedCounts, statuses] = await Promise.all([
    countMap(conn, DELETE_TABLES),
    count(conn, "shared_sms_log", "WHERE purpose <> 'otp'"),
    count(conn, "shared_sms_log", "WHERE purpose = 'otp'"),
    conn.execute("SELECT DISTINCT upper(trim(awb)) AS awb FROM parcels_parcel WHERE awb IS NOT NULL AND trim(awb) <> ''"),
    count(conn, "parcels_retired_tracking_number"),
    countMap(conn, PRESERVE_TABLES),
    conn.execute("SELECT status, COUNT(*) AS count FROM parcels_parcel GROUP BY status ORDER BY status"),
  ]);
  const [deleteContentSha256, nonOtpSmsContentSha256, otpSmsContentSha256, existingRetiredTrackingNumberContentSha256, preservedContentSha256] = await Promise.all([
    contentHashMap(conn, DELETE_TABLES, deleteCounts),
    queryContentHash(conn, "SELECT * FROM shared_sms_log WHERE purpose <> 'otp' ORDER BY rowid"),
    queryContentHash(conn, "SELECT * FROM shared_sms_log WHERE purpose = 'otp' ORDER BY rowid"),
    tableContentHash(conn, "parcels_retired_tracking_number"),
    contentHashMap(conn, PRESERVE_TABLES, preservedCounts),
  ]);
  const numbers = parcelNumbers.rows.map((row) => String(row.awb));
  const existing = await conn.execute("SELECT tracking_number FROM parcels_retired_tracking_number");
  const existingSet = new Set(existing.rows.map((row) => String(row.tracking_number)));
  const newRetiredTrackingNumberCount = numbers.filter((number) => !existingSet.has(number)).length;
  const deletionTotal = Object.values(deleteCounts).reduce((sum, value) => sum + value, 0) + nonOtpSmsRows;
  const parcelStatuses = Object.fromEntries(statuses.rows.map((row) => [String(row.status), Number(row.count)]));
  const canonical = JSON.stringify({
    target,
    databaseFingerprint,
    deleteCounts,
    deleteContentSha256,
    nonOtpSmsRows,
    nonOtpSmsContentSha256,
    otpSmsRowsBefore,
    otpSmsContentSha256,
    parcelStatuses,
    parcelTrackingNumberCount: numbers.length,
    existingRetiredTrackingNumberCount,
    newRetiredTrackingNumberCount,
    existingRetiredTrackingNumberContentSha256,
    preservedCounts,
    preservedContentSha256,
    deletionTotal,
  });
  return {
    target: target as Target,
    databaseFingerprint,
    deleteCounts,
    deleteContentSha256,
    nonOtpSmsRows,
    nonOtpSmsContentSha256,
    otpSmsRowsBefore,
    otpSmsContentSha256,
    parcelStatuses,
    parcelTrackingNumberCount: numbers.length,
    existingRetiredTrackingNumberCount,
    newRetiredTrackingNumberCount,
    existingRetiredTrackingNumberContentSha256,
    preservedCounts,
    preservedContentSha256,
    deletionTotal,
    planSha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

async function verifyAfter(conn: Executor, before: Plan, auditId: string, retirementReason: string) {
  const deleteCountsAfter = await countMap(conn, DELETE_TABLES);
  const nonOtpSmsRowsAfter = await count(conn, "shared_sms_log", "WHERE purpose <> 'otp'");
  if (Object.values(deleteCountsAfter).some((value) => value !== 0) || nonOtpSmsRowsAfter !== 0) {
    throw new Error("Post-delete verification failed: one or more approved transactional tables are not empty.");
  }
  const preservedAfter = await countMap(conn, PRESERVE_TABLES);
  for (const table of PRESERVE_TABLES) {
    const expected = table === "shared_audit_log" ? before.preservedCounts[table]! + 1 : before.preservedCounts[table]!;
    if (preservedAfter[table] !== expected) {
      throw new Error(`Preservation check failed for ${table}; the transaction will be rolled back.`);
    }
  }
  const preservedContentAfter = await contentHashMap(conn, PRESERVE_TABLES.filter((table) => table !== "shared_audit_log"), preservedAfter);
  for (const table of PRESERVE_TABLES) {
    if (table !== "shared_audit_log" && preservedContentAfter[table] !== before.preservedContentSha256[table]) {
      throw new Error(`Preserved content changed for ${table}; the transaction will be rolled back.`);
    }
  }
  const priorAuditContentAfter = await queryContentHash(conn, "SELECT * FROM shared_audit_log WHERE id <> ? ORDER BY rowid", [auditId]);
  if (priorAuditContentAfter !== before.preservedContentSha256.shared_audit_log) {
    throw new Error("Existing audit history changed; the transaction will be rolled back.");
  }
  const retiredAfter = await count(conn, "parcels_retired_tracking_number");
  if (retiredAfter !== before.existingRetiredTrackingNumberCount + before.newRetiredTrackingNumberCount) {
    throw new Error("Post-delete verification failed: retired-number count did not match the plan.");
  }
  const otpLogsAfter = await count(conn, "shared_sms_log", "WHERE purpose = 'otp'");
  if (otpLogsAfter !== before.otpSmsRowsBefore) {
    throw new Error("Authentication OTP SMS history changed unexpectedly.");
  }
  const otpSmsContentAfter = await queryContentHash(conn, "SELECT * FROM shared_sms_log WHERE purpose = 'otp' ORDER BY rowid");
  if (otpSmsContentAfter !== before.otpSmsContentSha256) {
    throw new Error("Authentication OTP SMS content changed unexpectedly.");
  }
  const existingRetiredContentAfter = await tableContentHash(conn, "parcels_retired_tracking_number", "WHERE reason <> ?", [retirementReason]);
  if (existingRetiredContentAfter !== before.existingRetiredTrackingNumberContentSha256) {
    throw new Error("Existing retired tracking-number records changed; the transaction will be rolled back.");
  }
}

async function main() {
  const plan = await planFor(client);
  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (plan.planSha256 !== expectedPlanHash) {
    throw new Error("Current database no longer matches the reviewed plan hash; no rows were changed.");
  }

  const tx = await client.transaction("write");
  try {
    const conn = tx as unknown as Executor;
    const lockedPlan = await planFor(conn);
    if (lockedPlan.planSha256 !== expectedPlanHash) {
      throw new Error("Database changed before the write transaction began; no rows were changed.");
    }
    const now = Math.floor(Date.now() / 1000);
    const operationId = prefixedId("reset");
    const retirementReason = `pre_live_transactional_data_cleanup:${operationId}`;
    const tombstoneInsert = await conn.execute({
      sql: `INSERT OR IGNORE INTO parcels_retired_tracking_number (tracking_number, reason, retired_at)
            SELECT DISTINCT upper(trim(awb)), ?, ?
            FROM parcels_parcel WHERE awb IS NOT NULL AND trim(awb) <> ''`,
      args: [retirementReason, now],
    } as never);
    if (tombstoneInsert.rowsAffected !== lockedPlan.newRetiredTrackingNumberCount) {
      throw new Error("Tombstone backfill count did not match the reviewed plan; transaction will roll back.");
    }

    for (const table of DELETE_TABLES) await conn.execute(`DELETE FROM "${table}"`);
    await conn.execute("DELETE FROM shared_sms_log WHERE purpose <> 'otp'");

    const auditId = prefixedId("aud");
    const requestId = prefixedId("req");
    const beforeJson = JSON.stringify({
      planSha256: lockedPlan.planSha256,
      deletedRows: lockedPlan.deleteCounts,
      nonOtpSmsRows: lockedPlan.nonOtpSmsRows,
      deletedContentSha256: lockedPlan.deleteContentSha256,
      nonOtpSmsContentSha256: lockedPlan.nonOtpSmsContentSha256,
      preservedContentSha256: lockedPlan.preservedContentSha256,
      retiredTrackingNumbersAdded: lockedPlan.newRetiredTrackingNumberCount,
      parcelStatuses: lockedPlan.parcelStatuses,
    });
    const afterJson = JSON.stringify({
      transactionalTablesCleared: true,
      authenticationOtpSmsPreserved: true,
      awbBatchInventoryPreserved: lockedPlan.preservedCounts.parcels_awb_batch_label,
      rateCardsPreserved: lockedPlan.preservedCounts.merchants_rate_card,
    });
    await conn.execute({
      sql: `INSERT INTO shared_audit_log (id, entity, entity_id, action, actor_id, actor_role, branch_id, device_id, request_id, before_json, after_json, ts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [auditId, "production_data_reset", operationId, "transactional_data_cleared", null, "system", null, null, requestId, beforeJson, afterJson, now],
    } as never);

    // Verify the approved deletion scope, setup, labels, audit event and tombstones before commit.
    const auditCountAfter = await count(conn, "shared_audit_log");
    const expectedAuditCount = lockedPlan.preservedCounts.shared_audit_log! + 1;
    if (auditCountAfter !== expectedAuditCount) throw new Error("The append-only audit event was not recorded as expected.");
    await verifyAfter(conn, lockedPlan, auditId, retirementReason);
    await tx.commit();
    console.log(JSON.stringify({
      target,
      status: "cleared-and-verified",
      planSha256: lockedPlan.planSha256,
      rowsDeleted: lockedPlan.deletionTotal,
      parcelTrackingNumbersRetired: lockedPlan.newRetiredTrackingNumberCount,
      preservedCounts: lockedPlan.preservedCounts,
      auditEventsAdded: 1,
    }, null, 2));
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Transactional cleanup failed.");
  process.exitCode = 1;
}).finally(() => {
  client.close();
});
