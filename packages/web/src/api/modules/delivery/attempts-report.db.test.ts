import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const dbPath = join(tmpdir(), `natex-delivery-report-${process.pid}-${Date.now()}.sqlite`);
const databaseUrl = `file:${dbPath}`;
process.env.DATABASE_URL = databaseUrl;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";
process.env.SMS_DISABLE_ALL = "true";

const { createClient } = await import("@libsql/client");
const setup = createClient({ url: databaseUrl });
await setup.execute(`CREATE TABLE identity_branch (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL,
  phone TEXT, lat_e6 INTEGER, lng_e6 INTEGER, type TEXT NOT NULL, parent_hub_id TEXT,
  status TEXT NOT NULL DEFAULT 'active', counter_rate_card_id TEXT, created_at INTEGER NOT NULL
)`);
await setup.execute(`CREATE TABLE delivery_runsheet (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, rider_id TEXT NOT NULL, rider_name TEXT NOT NULL,
  branch_id TEXT NOT NULL, hub_id TEXT NOT NULL, run_date TEXT NOT NULL, status TEXT NOT NULL
)`);
await setup.execute(`CREATE TABLE delivery_attempt (
  id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL, awb TEXT NOT NULL, runsheet_id TEXT,
  attempt_no INTEGER NOT NULL, outcome TEXT NOT NULL, reason_label TEXT, rider_id TEXT,
  rider_name TEXT, ts INTEGER NOT NULL
)`);
await setup.execute(`CREATE TABLE parcels_parcel (
  id TEXT PRIMARY KEY, awb TEXT NOT NULL, merchant_id TEXT, branch_id TEXT NOT NULL,
  status TEXT NOT NULL, weight_grams INTEGER NOT NULL, length_cm INTEGER, width_cm INTEGER,
  height_cm INTEGER, description TEXT, declared_value_cents INTEGER, cod_amount_cents INTEGER NOT NULL,
  cod_locked_at INTEGER, origin_address TEXT NOT NULL, origin_lat_e6 INTEGER, origin_lng_e6 INTEGER,
  consignee_name TEXT NOT NULL, consignee_phone TEXT NOT NULL, dest_address TEXT NOT NULL,
  dest_lat_e6 INTEGER, dest_lng_e6 INTEGER, dest_zone_id TEXT, delivery_attempts INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`);

for (const [id, code, name, type, parentHubId] of [
  ["report_hub", "HUB", "Report Hub", "hub", null],
  ["report_child", "CHD", "Child Branch", "branch", "report_hub"],
  ["report_other", "OTH", "Other Branch", "branch", null],
] as const) {
  await setup.execute({
    sql: `INSERT INTO identity_branch
      (id, code, name, address, type, parent_hub_id, status, created_at)
      VALUES (?, ?, ?, 'Test Road', ?, ?, 'active', 1793400000)`,
    args: [id, code, name, type, parentHubId],
  });
}
for (const [id, code, branchId, riderId, riderName] of [
  ["report_run_child", "RS-CHILD", "report_child", "rider-1", "Rider One"],
  ["report_run_other", "RS-OTHER", "report_other", "rider-2", "Rider Two"],
] as const) {
  await setup.execute({
    sql: `INSERT INTO delivery_runsheet (id, code, rider_id, rider_name, branch_id, hub_id, run_date, status)
      VALUES (?, ?, ?, ?, ?, ?, '2026-11-01', 'closed')`,
    args: [id, code, riderId, riderName, branchId, "report_hub"],
  });
}
const seconds = (value: string) => Math.floor(new Date(value).getTime() / 1000);
const attemptRows = [
  {
    id: "report_a1",
    parcel: "parcel_a1",
    awb: "NXREPORT001",
    run: "report_run_child",
    outcome: "failed",
    reason: "No answer",
    ts: "2026-11-01T00:00:00+05:30",
    branch: "report_child",
  },
  {
    id: "report_a2",
    parcel: "parcel_a2",
    awb: "NXREPORT002",
    run: "report_run_other",
    outcome: "delivered",
    reason: null,
    ts: "2026-11-01T12:00:00+05:30",
    branch: "report_other",
  },
  {
    id: "report_a3",
    parcel: "parcel_a3",
    awb: "NXREPORT003",
    run: null,
    outcome: "failed",
    reason: "Off-run local",
    ts: "2026-11-01T23:59:59+05:30",
    branch: "report_child",
  },
  {
    id: "report_a4",
    parcel: "parcel_a4",
    awb: "NXREPORT004",
    run: null,
    outcome: "failed",
    reason: "Off-run foreign",
    ts: "2026-11-02T00:00:00+05:30",
    branch: "report_other",
  },
];
for (const row of attemptRows) {
  await setup.execute({
    sql: `INSERT INTO parcels_parcel
      (id, awb, branch_id, status, weight_grams, cod_amount_cents, origin_address,
       consignee_name, consignee_phone, dest_address, delivery_attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'Delivered', 500, 0, 'Origin', 'Receiver', '+94770000000', 'Destination', 1, ?, ?)`,
    args: [row.parcel, row.awb, row.branch, seconds(row.ts), seconds(row.ts)],
  });
  await setup.execute({
    sql: `INSERT INTO delivery_attempt
      (id, parcel_id, awb, runsheet_id, attempt_no, outcome, reason_label, rider_id, rider_name, ts)
      VALUES (?, ?, ?, ?, 1, ?, ?, 'rider-op', 'Operator', ?)`,
    args: [row.id, row.parcel, row.awb, row.run, row.outcome, row.reason, seconds(row.ts)],
  });
}

const delivery = await import("./service");
afterAll(async () => {
  setup.close();
  rmSync(dbPath, { force: true });
});

describe("Delivery attempts report (scratch SQLite)", () => {
  test("Ops sees assigned/child rows and proven off-run attempts, with exact Colombo day bounds", async () => {
    const result = await delivery.deliveryAttemptsReport(
      {
        fromDate: "2026-11-01",
        toDate: "2026-11-01",
        page: 1,
        pageSize: 1,
      },
      ["report_hub", "report_child"],
    );

    expect(result.total).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      awb: "NXREPORT003",
      outcome: "failed",
      failureReason: "Off-run local",
      branchLabel: "CHD · Child Branch",
      riderId: "rider-op",
      runsheetCode: null,
    });
    expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual([
      "attemptNo",
      "awb",
      "branchLabel",
      "failureReason",
      "outcome",
      "riderId",
      "riderName",
      "runsheetCode",
      "timestamp",
    ]);
    expect(result.rows[0]).not.toHaveProperty("consigneePhone");
    expect(result.rows[0]).not.toHaveProperty("lat");
    expect(result.rows[0]).not.toHaveProperty("podId");
  });

  test("branch filters narrow Ops scope and Admin branch filters resolve off-runsheet parcel branches", async () => {
    const scopedFilter = await delivery.deliveryAttemptsReport(
      {
        branchId: "report_child",
        page: 1,
        pageSize: 25,
      },
      ["report_hub", "report_child"],
    );
    const deniedScopeFilter = await delivery.deliveryAttemptsReport(
      {
        branchId: "report_other",
        page: 1,
        pageSize: 25,
      },
      ["report_hub", "report_child"],
    );
    const admin = await delivery.deliveryAttemptsReport(
      {
        fromDate: "2026-11-02",
        toDate: "2026-11-02",
        page: 1,
        pageSize: 25,
      },
      null,
    );
    const adminBranchFilter = await delivery.deliveryAttemptsReport(
      {
        fromDate: "2026-11-02",
        toDate: "2026-11-02",
        branchId: "report_other",
        page: 1,
        pageSize: 25,
      },
      null,
    );

    expect(scopedFilter.total).toBe(2);
    expect(deniedScopeFilter.total).toBe(0);
    expect(admin.rows).toHaveLength(1);
    expect(admin.rows[0]).toMatchObject({
      awb: "NXREPORT004",
      branchLabel: "OTH · Other Branch",
      runsheetCode: null,
    });
    expect(adminBranchFilter.total).toBe(1);
    expect(adminBranchFilter.rows[0]).toMatchObject({
      awb: "NXREPORT004",
      branchLabel: "OTH · Other Branch",
    });
  });
});
