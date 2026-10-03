/**
 * Backup and restore drill (§10 M5 — monitoring: "backup/restore drill").
 *
 * 1. BACKUP — opens one read transaction on the live database (a consistent
 *    snapshot: writes that land mid-dump are not half-included) and writes a
 *    logical dump: schema DDL plus every row as INSERT statements, gzipped,
 *    with a manifest of per-table row counts and content hashes.
 * 2. RESTORE — replays that file into a brand-new scratch SQLite database
 *    (never the live one), then
 * 3. VERIFY — integrity_check, foreign_key_check, and per-table row count +
 *    content hash against the manifest taken at dump time. Any mismatch fails.
 *
 * It reports how long each phase took (the numbers to quote as the restore
 * time in RUNBOOK.md) and keeps the dump unless --discard is passed.
 *
 *   bun --env-file=../../.env scripts/backup-drill.ts [--out /path/dir] [--discard]
 *
 * The hosted database (Turso) also has the provider's own point-in-time
 * restore. This drill is the provider-independent copy: it proves we can get
 * the data out and back without them.
 */

import { createClient, type Client, type Row } from "@libsql/client";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join } from "node:path";

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1]! : "/tmp/natex-backups";
const discard = args.includes("--discard");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const PAGE = 500;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — run with --env-file=../../.env");

const live = createClient({ url: process.env.DATABASE_URL, authToken: process.env.DATABASE_AUTH_TOKEN });

type TableManifest = { name: string; rows: number; sha256: string };
type Manifest = { takenAt: string; source: string; tables: TableManifest[] };

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return `X'${Buffer.from(bytes).toString("hex")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Stable per-row hash input: column order is the table's, values as SQL literals. */
const rowLine = (row: Row, cols: string[]) => cols.map((c) => literal(row[c])).join(",");

async function listObjects(c: Pick<Client, "execute">) {
  const r = await c.execute(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name",
  );
  return r.rows.map((x) => ({ type: String(x.type), name: String(x.name), sql: String(x.sql) }));
}

/** Rows in a deterministic order so both sides hash identically. */
async function* readTable(c: Pick<Client, "execute">, table: string) {
  const info = await c.execute(`PRAGMA table_info(${quoteIdent(table)})`);
  const cols = info.rows.map((r) => String(r.name));
  const pk = info.rows.filter((r) => Number(r.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((r) => String(r.name));
  const order = (pk.length ? pk : cols).map(quoteIdent).join(", ");
  for (let offset = 0; ; offset += PAGE) {
    const r = await c.execute(`SELECT ${cols.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)} ORDER BY ${order} LIMIT ${PAGE} OFFSET ${offset}`);
    yield { cols, rows: r.rows };
    if (r.rows.length < PAGE) return;
  }
}

async function hashTable(c: Pick<Client, "execute">, table: string): Promise<TableManifest> {
  const h = createHash("sha256");
  let rows = 0;
  for await (const page of readTable(c, table)) {
    for (const row of page.rows) {
      h.update(rowLine(row, page.cols));
      h.update("\n");
      rows++;
    }
  }
  return { name: table, rows, sha256: h.digest("hex") };
}

const ms = (t: number) => `${((performance.now() - t) / 1000).toFixed(1)} s`;
let failed = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

// ── 1. backup ────────────────────────────────────────────────────────────────
console.log(`\nBackup/restore drill — ${stamp}\n\n1. Backup (one read transaction on the live database)`);
const t1 = performance.now();
const tx = await live.transaction("read");
const lines: string[] = ["PRAGMA foreign_keys=OFF;", "BEGIN;"];
const manifest: Manifest = { takenAt: new Date().toISOString(), source: process.env.DATABASE_URL.replace(/\/\/([^.]{6})[^.]*/, "//$1…"), tables: [] };
try {
  const objects = await listObjects(tx);
  const tables = objects.filter((o) => o.type === "table");
  for (const t of tables) lines.push(`${t.sql};`);
  for (const t of tables) {
    const h = createHash("sha256");
    let rows = 0;
    for await (const page of readTable(tx, t.name)) {
      for (const row of page.rows) {
        const values = rowLine(row, page.cols);
        h.update(values);
        h.update("\n");
        lines.push(`INSERT INTO ${quoteIdent(t.name)} (${page.cols.map(quoteIdent).join(",")}) VALUES (${values});`);
        rows++;
      }
    }
    manifest.tables.push({ name: t.name, rows, sha256: h.digest("hex") });
  }
  for (const o of objects.filter((x) => x.type !== "table")) lines.push(`${o.sql};`);
  lines.push("COMMIT;");
} finally {
  tx.close();
}
mkdirSync(outDir, { recursive: true });
const dumpPath = join(outDir, `natex-${stamp}.sql.gz`);
const manifestPath = join(outDir, `natex-${stamp}.manifest.json`);
writeFileSync(dumpPath, gzipSync(lines.join("\n")));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const totalRows = manifest.tables.reduce((n, t) => n + t.rows, 0);
const backupTime = ms(t1);
check(manifest.tables.length > 0 && totalRows > 0, "dump written", `${manifest.tables.length} tables, ${totalRows} rows, ${(statSync(dumpPath).size / 1024).toFixed(0)} KiB gz in ${backupTime} → ${dumpPath}`);

// ── 2. restore into a scratch database ───────────────────────────────────────
console.log("\n2. Restore into a scratch database (never the live one)");
const scratchPath = `/tmp/natex-restore-${stamp}.db`;
const t2 = performance.now();
const scratch = createClient({ url: `file:${scratchPath}` });
const sql = gunzipSync(readFileSync(dumpPath)).toString("utf8");
await scratch.executeMultiple(sql);
const restoreTime = ms(t2);
check(true, "dump replayed", `${scratchPath} in ${restoreTime}`);

// ── 3. verify ────────────────────────────────────────────────────────────────
console.log("\n3. Verify the restored copy");
const integrity = await scratch.execute("PRAGMA integrity_check");
check(String(integrity.rows[0]?.[0]) === "ok", "integrity_check", String(integrity.rows[0]?.[0]));
const fk = await scratch.execute("PRAGMA foreign_key_check");
check(fk.rows.length === 0, "foreign_key_check", `${fk.rows.length} violations`);

const restoredObjects = await listObjects(scratch);
const liveObjectCount = sql.split("\n").filter((l) => /^CREATE /i.test(l)).length;
check(restoredObjects.length >= liveObjectCount, "schema objects present", `${restoredObjects.length} tables/indexes/views`);

const mismatches: string[] = [];
for (const t of manifest.tables) {
  const got = await hashTable(scratch, t.name);
  if (got.rows !== t.rows || got.sha256 !== t.sha256) mismatches.push(`${t.name} ${t.rows}→${got.rows}`);
}
check(mismatches.length === 0, "every table: row count and content hash equal the dump-time manifest", mismatches.length ? mismatches.join(", ") : `${manifest.tables.length}/${manifest.tables.length} tables`);

// A business-level spot check: money and custody tables are the ones that matter.
for (const name of ["parcels_parcel", "parcels_parcel_event", "cod_entry", "cod_settlement", "shared_audit_log", "identity_user", "merchants_merchant"]) {
  const t = manifest.tables.find((x) => x.name === name);
  if (!t) {
    check(false, `spot check ${name}`, "table missing from the dump");
    continue;
  }
  const r = await scratch.execute(`SELECT count(*) AS n FROM ${quoteIdent(name)}`);
  check(Number(r.rows[0]?.n) === t.rows, `spot check ${name}`, `${t.rows} rows`);
}

// Prove the comparison can fail: change one value in the scratch copy and the
// hash for that table must no longer match.
const victim = manifest.tables.find((t) => t.name === "identity_user" && t.rows > 0);
if (victim) {
  await scratch.execute(`UPDATE identity_user SET name = name || ' (tampered)' WHERE rowid = (SELECT min(rowid) FROM identity_user)`);
  const after = await hashTable(scratch, victim.name);
  check(after.sha256 !== victim.sha256, "tamper self-test: a one-field change in the copy is detected", after.sha256 !== victim.sha256 ? "hash differs" : "hash still equal");
}

scratch.close();
live.close();
rmSync(scratchPath, { force: true });
if (discard) {
  rmSync(dumpPath, { force: true });
  rmSync(manifestPath, { force: true });
}

console.log(`\nbackup ${backupTime} · restore ${restoreTime} · ${totalRows} rows`);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nDRILL PASSED");
process.exit(failed ? 1 : 0);
