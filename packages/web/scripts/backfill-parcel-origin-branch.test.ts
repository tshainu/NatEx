import { afterAll, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dbPath = join(tmpdir(), `natex-origin-backfill-${process.pid}-${Date.now()}.sqlite`);
const databaseUrl = `file:${dbPath}`;
const client = createClient({ url: databaseUrl });
const scriptPath = fileURLToPath(new URL("./backfill-parcel-origin-branch.ts", import.meta.url));
const env = { ...process.env, DATABASE_URL: databaseUrl, DATABASE_AUTH_TOKEN: "", NODE_ENV: "test" };

await client.execute(`CREATE TABLE parcels_parcel (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  origin_branch_id TEXT
)`);
await client.execute(`CREATE TABLE parcels_parcel_event (
  id TEXT PRIMARY KEY,
  parcel_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  notes TEXT
)`);
await client.execute(`CREATE TABLE identity_branch (id TEXT PRIMARY KEY)`);
await client.batch([
  { sql: "INSERT INTO identity_branch (id) VALUES (?)", args: ["hub-a"] },
  { sql: "INSERT INTO identity_branch (id) VALUES (?)", args: ["hub-b"] },
  { sql: "INSERT INTO identity_branch (id) VALUES (?)", args: ["hub-c"] },
  { sql: "INSERT INTO parcels_parcel (id, branch_id) VALUES (?, ?)", args: ["moved", "hub-b"] },
  { sql: "INSERT INTO parcels_parcel (id, branch_id) VALUES (?, ?)", args: ["never-moved", "hub-c"] },
  { sql: "INSERT INTO parcels_parcel (id, branch_id) VALUES (?, ?)", args: ["malformed", "hub-b"] },
  { sql: "INSERT INTO parcels_parcel (id, branch_id) VALUES (?, ?)", args: ["ambiguous", "hub-c"] },
  { sql: "INSERT INTO parcels_parcel (id, branch_id, origin_branch_id) VALUES (?, ?, ?)", args: ["already-set", "hub-b", "hub-a"] },
  { sql: "INSERT INTO parcels_parcel_event (id, parcel_id, ts, notes) VALUES (?, ?, ?, ?)", args: ["move-later", "moved", 20, "Accountability moved from hub-b to hub-c."] },
  { sql: "INSERT INTO parcels_parcel_event (id, parcel_id, ts, notes) VALUES (?, ?, ?, ?)", args: ["move-first", "moved", 10, "Hub receipt. Accountability moved from hub-a to hub-b."] },
  { sql: "INSERT INTO parcels_parcel_event (id, parcel_id, ts, notes) VALUES (?, ?, ?, ?)", args: ["bad-first", "malformed", 5, "Accountability moved from broken history"] },
  { sql: "INSERT INTO parcels_parcel_event (id, parcel_id, ts, notes) VALUES (?, ?, ?, ?)", args: ["conflict-a", "ambiguous", 5, "Accountability moved from hub-a to hub-c."] },
  { sql: "INSERT INTO parcels_parcel_event (id, parcel_id, ts, notes) VALUES (?, ?, ?, ?)", args: ["conflict-b", "ambiguous", 5, "Accountability moved from hub-b to hub-c."] },
], "write");

afterAll(() => {
  client.close();
  rmSync(dbPath, { force: true });
});

describe("parcel origin backfill CLI (scratch SQLite)", () => {
  test("plans, applies proven rows only, and is safe to re-plan", async () => {
    const plan = JSON.parse(execFileSync(
      process.execPath,
      [scriptPath, "--target=local-test", "--plan"],
      { env, encoding: "utf8" },
    )) as {
      databaseFingerprint: string;
      planSha256: string;
      assignmentsToBackfill: number;
      alreadySet: number;
      unresolved: Record<string, number>;
    };

    expect(plan.assignmentsToBackfill).toBe(2);
    expect(plan.alreadySet).toBe(1);
    expect(plan.unresolved).toEqual({ "malformed-transfer": 1, "ambiguous-transfer": 1 });

    const applied = JSON.parse(execFileSync(
      process.execPath,
      [
        scriptPath,
        "--target=local-test",
        "--apply",
        "--confirm-local-test",
        "--allow-unresolved",
        "--backup-id=local-scratch",
        `--expected-database-sha256=${plan.databaseFingerprint}`,
        `--expected-plan-sha256=${plan.planSha256}`,
      ],
      { env, encoding: "utf8" },
    )) as { result: string; assignedRows: number; unresolvedFromReviewedPlan: number };

    expect(applied).toMatchObject({ result: "applied", assignedRows: 2, unresolvedFromReviewedPlan: 2 });
    const rows = await client.execute("SELECT id, origin_branch_id FROM parcels_parcel ORDER BY id");
    const byId = Object.fromEntries(rows.rows.map((row) => [String(row.id), row.origin_branch_id === null ? null : String(row.origin_branch_id)]));
    expect(byId).toEqual({
      "already-set": "hub-a",
      ambiguous: null,
      malformed: null,
      "never-moved": "hub-c",
      moved: "hub-a",
    });

    const secondPlan = JSON.parse(execFileSync(
      process.execPath,
      [scriptPath, "--target=local-test", "--plan"],
      { env, encoding: "utf8" },
    )) as { assignmentsToBackfill: number; alreadySet: number };
    expect(secondPlan.assignmentsToBackfill).toBe(0);
    expect(secondPlan.alreadySet).toBe(3);
  });
});
