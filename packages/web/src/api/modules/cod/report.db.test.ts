import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const dbPath = join(tmpdir(), `natex-cod-report-${process.pid}-${Date.now()}.sqlite`);
const databaseUrl = `file:${dbPath}`;
process.env.DATABASE_URL = databaseUrl;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";

const { createClient } = await import("@libsql/client");
const setup = createClient({ url: databaseUrl });
await setup.execute(`CREATE TABLE parcels_parcel (
  id TEXT PRIMARY KEY, awb TEXT NOT NULL, merchant_id TEXT, branch_id TEXT NOT NULL,
  status TEXT NOT NULL, weight_grams INTEGER NOT NULL, length_cm INTEGER, width_cm INTEGER,
  height_cm INTEGER, description TEXT, declared_value_cents INTEGER DEFAULT 0,
  cod_amount_cents INTEGER NOT NULL DEFAULT 0, cod_locked_at INTEGER, origin_address TEXT NOT NULL,
  origin_lat_e6 INTEGER, origin_lng_e6 INTEGER, consignee_name TEXT NOT NULL,
  consignee_phone TEXT NOT NULL, dest_address TEXT NOT NULL, dest_lat_e6 INTEGER,
  dest_lng_e6 INTEGER, dest_zone_id TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`);
await setup.execute(`CREATE TABLE cod_entry (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, type TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  debit_account TEXT NOT NULL, credit_account TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'cash',
  ref TEXT, parcel_id TEXT, awb TEXT, merchant_id TEXT, rider_id TEXT, branch_id TEXT,
  deposit_id TEXT, settlement_id TEXT, reversal_of_id TEXT, reversed_by_id TEXT, note TEXT,
  actor_id TEXT, actor_name TEXT, actor_role TEXT, client_id TEXT, ts INTEGER NOT NULL
)`);

const parcels = await import("../parcels/service");
const cod = await import("./service");
const branchA = "cod_test_branch_a";
const branchB = "cod_test_branch_b";
const start = new Date("2026-11-01T00:00:00+05:30");
const end = new Date("2026-11-13T23:59:00+05:30");
const outsideDate = new Date("2026-10-31T23:59:00+05:30");

for (const row of [
  { id: "parcel_match", awb: "NXCODMATCH001", branch: branchA, expected: 520000, createdAt: start, status: "Delivered" },
  { id: "parcel_nocollect", awb: "NXCODOPEN001", branch: branchA, expected: 310000, createdAt: end, status: "OutForDelivery" },
  { id: "parcel_other_branch", awb: "NXCODOTHER001", branch: branchB, expected: 100000, createdAt: end, status: "Delivered" },
  { id: "parcel_outside_date", awb: "NXCODOLD001", branch: branchA, expected: 100000, createdAt: outsideDate, status: "Delivered" },
  { id: "parcel_zero", awb: "NXCODZERO001", branch: branchA, expected: 0, createdAt: end, status: "Delivered" },
]) {
  await setup.execute({
    sql: `INSERT INTO parcels_parcel
      (id, awb, branch_id, status, weight_grams, cod_amount_cents, origin_address,
       consignee_name, consignee_phone, dest_address, created_at, updated_at)
      VALUES (?, ?, ?, ?, 500, ?, 'Origin', 'Test', '+94770000000', 'Destination', ?, ?)`,
    args: [row.id, row.awb, row.branch, row.status, row.expected, Math.floor(row.createdAt.getTime() / 1000), Math.floor(row.createdAt.getTime() / 1000)],
  });
}

const ts = Math.floor(new Date("2026-11-13T05:00:00Z").getTime() / 1000);
await setup.execute({
  sql: `INSERT INTO cod_entry
    (id, seq, type, amount_cents, debit_account, credit_account, parcel_id, awb, branch_id, ts)
    VALUES (?, 1, 'COLLECT', 520000, 'rider_cash', 'cod_claim', ?, ?, ?, ?)`,
  args: ["cod_collect_match", "parcel_match", "NXCODMATCH001", branchA, ts],
});
await setup.execute({
  sql: `INSERT INTO cod_entry
    (id, seq, type, amount_cents, debit_account, credit_account, parcel_id, awb, branch_id,
     reversal_of_id, ts)
    VALUES (?, 2, 'REVERSAL', 310000, 'cod_claim', 'rider_cash', ?, ?, ?, ?, ?)`,
  args: ["cod_reverse_missing", "parcel_nocollect", "NXCODOPEN001", branchA, "cod_collect_reversed", ts + 10],
});
await setup.execute({
  sql: `INSERT INTO cod_entry
    (id, seq, type, amount_cents, debit_account, credit_account, parcel_id, awb, branch_id,
     reversed_by_id, ts)
    VALUES (?, 3, 'COLLECT', 310000, 'rider_cash', 'cod_claim', ?, ?, ?, ?, ?)`,
  args: ["cod_collect_reversed", "parcel_nocollect", "NXCODOPEN001", branchA, "cod_reverse_missing", ts],
});

afterAll(async () => {
  await setup.close();
  rmSync(dbPath, { force: true });
});

describe("COD expected-versus-collected report (scratch SQLite)", () => {
  test("filters Colombo booking dates, nonzero COD, and authorized branches before pagination", async () => {
    const result = await parcels.expectedCodParcelsForReport(
      { enteredFrom: "2026-11-01", enteredTo: "2026-11-13", page: 1, pageSize: 25 },
      [branchA],
    );
    expect(result.total).toBe(2);
    expect(result.rows.map((row) => row.awb).sort()).toEqual(["NXCODMATCH001", "NXCODOPEN001"]);
  });

  test("collection facts include live COLLECT entries and exclude both sides of reversals", async () => {
    const result = await cod.collectionFactsForReport(["parcel_match", "parcel_nocollect"]);
    expect(result).toEqual([
      {
        parcelId: "parcel_match",
        collectedCents: 520000,
        collectedAt: new Date(ts * 1000),
      },
    ]);
  });
});
