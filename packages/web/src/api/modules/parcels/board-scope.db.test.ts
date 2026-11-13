import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const dbPath = join(tmpdir(), `natex-board-scope-${process.pid}-${Date.now()}.sqlite`);
const databaseUrl = `file:${dbPath}`;
process.env.DATABASE_URL = databaseUrl;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";
process.env.SMS_DISABLE_ALL = "true";
delete process.env.SMS_EXECUTION_URL;

const { createClient } = await import("@libsql/client");
const setup = createClient({ url: databaseUrl });
await setup.execute(`CREATE TABLE parcels_parcel (
  id TEXT PRIMARY KEY, awb TEXT NOT NULL UNIQUE, merchant_id TEXT, branch_id TEXT NOT NULL,
  status TEXT NOT NULL, weight_grams INTEGER NOT NULL, length_cm INTEGER, width_cm INTEGER, height_cm INTEGER,
  description TEXT, declared_value_cents INTEGER DEFAULT 0, cod_amount_cents INTEGER NOT NULL DEFAULT 0,
  cod_locked_at INTEGER, origin_address TEXT NOT NULL, origin_lat_e6 INTEGER, origin_lng_e6 INTEGER,
  consignee_name TEXT NOT NULL, consignee_phone TEXT NOT NULL, dest_address TEXT NOT NULL,
  dest_lat_e6 INTEGER, dest_lng_e6 INTEGER, dest_zone_id TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`);
await setup.execute(`CREATE TABLE parcels_parcel_event (
  id TEXT PRIMARY KEY, parcel_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
  actor_id TEXT, actor_name TEXT, actor_role TEXT, device_id TEXT, lat_e6 INTEGER, lng_e6 INTEGER,
  notes TEXT, client_id TEXT, ts INTEGER NOT NULL
)`);
await setup.execute(`CREATE TABLE delivery_runsheet (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, rider_id TEXT NOT NULL, rider_name TEXT NOT NULL,
  branch_id TEXT NOT NULL, hub_id TEXT NOT NULL, run_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  planned_count INTEGER NOT NULL DEFAULT 0, delivered_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0, cod_expected_cents INTEGER NOT NULL DEFAULT 0,
  cod_collected_cents INTEGER NOT NULL DEFAULT 0, freight_expected_cents INTEGER NOT NULL DEFAULT 0,
  freight_collected_cents INTEGER NOT NULL DEFAULT 0, route_method TEXT, route_distance_metres INTEGER,
  optimised_at INTEGER, dispatched_at INTEGER, closed_at INTEGER, created_at INTEGER NOT NULL,
  created_by_name TEXT
)`);
await setup.execute(`CREATE TABLE transport_bag (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, trip_id TEXT
)`);
await setup.execute(`CREATE TABLE transport_bag_item (
  id TEXT PRIMARY KEY, bag_id TEXT NOT NULL, parcel_id TEXT NOT NULL, removed_at INTEGER
)`);
await setup.execute(`CREATE TABLE transport_trip (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, expected_arrival_at INTEGER
)`);
await setup.execute(`CREATE TABLE transport_hub_scan (
  id TEXT PRIMARY KEY, parcel_id TEXT, branch_id TEXT NOT NULL, hub_id TEXT,
  outcome TEXT NOT NULL, ts INTEGER NOT NULL
)`);

const { colomboToday } = await import("../../shared/time");
const parcels = await import("./service");
const delivery = await import("../delivery/service");
const transport = await import("../transport/service");

type Scope = import("../../shared/auth").Principal;
const branchA = "scope_test_branch_a";
const branchB = "scope_test_branch_b";
const ops: Scope = {
  userId: "scope_test_ops",
  name: "Scope test Operations",
  role: "ops",
  // Active role, not secondary role membership, controls global scope.
  roles: ["ops", "admin"],
  branchId: branchA,
  merchantId: null,
};
const admin: Scope = {
  ...ops,
  role: "admin",
  roles: ["admin", "ops"],
  branchId: "",
};
const missingBranch: Scope = { ...ops, branchId: "" };

const now = new Date();
const nowSeconds = Math.floor(now.getTime() / 1000);
const parcelRows = [
  {
    id: "scope_a_local",
    awb: "NXSCOPETESTA001",
    branchId: branchA,
    status: "Delivered",
    origin: "Origin branch: elsewhere",
    destination: "Destination branch: elsewhere",
  },
  {
    id: "scope_a_hold",
    awb: "NXSCOPETESTA002",
    branchId: branchA,
    status: "OnHold",
    origin: "Origin branch: elsewhere",
    destination: "Destination branch: elsewhere",
  },
  {
    id: "scope_b_cross",
    awb: "NXSCOPETESTB001",
    branchId: branchB,
    status: "Delivered",
    // These address hints deliberately mention branch A. Accountability is the
    // parcel's current branch_id, not its origin/destination text or old events.
    origin: `Origin branch: ${branchA}`,
    destination: `Destination branch: ${branchA}`,
  },
];

for (const row of parcelRows) {
  await setup.execute({
    sql: `INSERT INTO parcels_parcel
      (id, awb, merchant_id, branch_id, status, weight_grams, cod_amount_cents,
       origin_address, consignee_name, consignee_phone, dest_address, delivery_attempts,
       created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, 500, 2500, ?, ?, '+94770000000', ?, 0, ?, ?)`,
    args: [row.id, row.awb, row.branchId, row.status, row.origin, `Receiver ${row.id}`, row.destination, nowSeconds, nowSeconds],
  });
}
for (const [i, [parcelId, status]] of [
  ["scope_a_local", "Booked"],
  ["scope_a_local", "Delivered"],
  ["scope_a_hold", "OnHold"],
  ["scope_b_cross", "Booked"],
  ["scope_b_cross", "Delivered"],
].entries()) {
  await setup.execute({
    sql: `INSERT INTO parcels_parcel_event
      (id, parcel_id, from_status, to_status, actor_name, actor_role, ts)
      VALUES (?, ?, NULL, ?, ?, 'ops', ?)`,
    args: [`scope_event_${i}`, parcelId, status, `Actor ${parcelId}`, nowSeconds + i],
  });
}
await setup.execute({
  sql: "UPDATE parcels_parcel SET created_at = ? WHERE id = ?",
  args: [nowSeconds - 10_800, "scope_a_hold"],
});
await setup.execute({
  sql: "UPDATE parcels_parcel_event SET ts = ? WHERE id = ?",
  args: [nowSeconds - 7_200, "scope_event_2"],
});
await setup.execute({
  sql: `INSERT INTO parcels_parcel_event
    (id, parcel_id, from_status, to_status, actor_role, ts)
    VALUES ('scope_event_same_status', 'scope_a_hold', 'OnHold', 'OnHold', 'ops', ?)`,
  args: [nowSeconds - 300],
});
await setup.execute({
  sql: `INSERT INTO transport_trip (id, status, expected_arrival_at)
    VALUES ('scope_trip', 'departed', ?)`,
  args: [nowSeconds + 3_600],
});
await setup.execute({
  sql: `INSERT INTO transport_bag (id, status, trip_id)
    VALUES ('scope_bag', 'in_transit', 'scope_trip')`,
});
await setup.execute({
  sql: `INSERT INTO transport_bag_item (id, bag_id, parcel_id, removed_at)
    VALUES ('scope_bag_item', 'scope_bag', 'scope_a_hold', NULL)`,
});
for (const [id, branchId, outcome, ts] of [
  ["scope_scan_old", branchA, "accepted", nowSeconds - 600],
  ["scope_scan_new", branchB, "accepted", nowSeconds - 300],
  ["scope_scan_rejected", branchA, "rejected", nowSeconds - 60],
] as const) {
  await setup.execute({
    sql: `INSERT INTO transport_hub_scan (id, parcel_id, branch_id, hub_id, outcome, ts)
      VALUES (?, 'scope_a_hold', ?, ?, ?, ?)`,
    args: [id, branchId, branchId, outcome, ts],
  });
}

const today = colomboToday();
const runsheetRows = [
  { id: "scope_run_a", branch: branchA, code: "SCOPE-A", status: "dispatched", planned: 4, delivered: 2, failed: 1, codExpected: 1200, codCollected: 400 },
  { id: "scope_run_b", branch: branchB, code: "SCOPE-B", status: "dispatched", planned: 90, delivered: 80, failed: 5, codExpected: 9900, codCollected: 8800 },
];
for (const row of runsheetRows) {
  await setup.execute({
    sql: `INSERT INTO delivery_runsheet
      (id, code, rider_id, rider_name, branch_id, hub_id, run_date, status, planned_count,
       delivered_count, failed_count, cod_expected_cents, cod_collected_cents,
       freight_expected_cents, freight_collected_cents, created_at)
      VALUES (?, ?, 'scope_rider', 'Scope rider', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    args: [row.id, row.code, row.branch, row.branch, today, row.status, row.planned, row.delivered, row.failed, row.codExpected, row.codCollected, nowSeconds],
  });
}

afterAll(async () => {
  setup.close();
  rmSync(dbPath, { force: true });
});

describe("Operations live-board allocation scope (scratch SQLite)", () => {
  test("counts, parcel stream, custody events, and throughput follow the active ops branch", async () => {
    const [counts, events, stream, trends] = await Promise.all([
      parcels.statusCounts(ops),
      parcels.recentEvents(ops),
      parcels.listParcels({ page: 1, pageSize: 100 }, ops),
      parcels.parcelTrends(ops, 14, now),
    ]);

    expect(Object.fromEntries(counts.map((row) => [row.status, row.count]))).toEqual({ Delivered: 1, OnHold: 1 });
    expect(new Set(stream.rows.map((row) => row.id))).toEqual(new Set(["scope_a_local", "scope_a_hold"]));
    expect(events.length).toBe(4);
    expect(events.every((event) => event.parcelId !== "scope_b_cross")).toBe(true);
    expect(trends.totals.booked).toBe(2);
    expect(trends.totals.delivered).toBe(1);
  });

  test("tampered branch filters cannot replace an ops allocation", async () => {
    const askingForOtherBranch = await parcels.listParcels(
      { page: 1, pageSize: 100, branchId: branchB },
      ops,
    );
    const askingForHomeBranch = await parcels.listParcels(
      { page: 1, pageSize: 100, branchId: branchA },
      { ...ops, branchId: branchB },
    );

    expect(askingForOtherBranch.rows.map((row) => row.branchId)).toEqual([branchA, branchA]);
    expect(askingForHomeBranch.rows.map((row) => row.branchId)).toEqual([branchB]);
  });

  test("today-run totals use the same branch allocation and missing allocation is empty", async () => {
    const [scoped, missing] = await Promise.all([
      delivery.deliveryCounts(ops),
      delivery.deliveryCounts(missingBranch),
    ]);

    expect(scoped).toMatchObject({
      runsheetsToday: 1,
      dispatched: 1,
      stopsPlanned: 4,
      delivered: 2,
      failed: 1,
      codExpectedCents: 1200,
      codCollectedCents: 400,
    });
    expect(missing.runsheetsToday).toBe(0);
    expect(missing.stopsPlanned).toBe(0);
    expect(missing.codExpectedCents).toBe(0);

    expect(await parcels.statusCounts(missingBranch)).toEqual([]);
    expect(await parcels.recentEvents(missingBranch)).toEqual([]);
    expect((await parcels.listParcels({ page: 1, pageSize: 100 }, missingBranch)).total).toBe(0);
    expect((await parcels.parcelTrends(missingBranch, 14, now)).totals.booked).toBe(0);
  });

  test("parcel aging uses current-stage entry, Colombo dates, and authorized branches", async () => {
    const ageNow = new Date(nowSeconds * 1000);
    const enteredDate = colomboToday(new Date((nowSeconds - 7_200) * 1000));
    const scoped = await parcels.parcelStatusAging(
      { page: 1, pageSize: 100, enteredFrom: enteredDate, enteredTo: enteredDate },
      [branchA],
      ageNow,
    );
    const tooYoung = await parcels.parcelStatusAging(
      { page: 1, pageSize: 100, minimumAgeHours: 3 },
      [branchA],
      ageNow,
    );
    const tampered = await parcels.parcelStatusAging(
      { page: 1, pageSize: 100, branchId: branchB },
      [branchA],
      ageNow,
    );
    const network = await parcels.parcelStatusAging(
      { page: 1, pageSize: 100, includeTerminal: true },
      null,
      ageNow,
    );

    expect(scoped.rows.map((row) => row.awb)).toEqual(["NXSCOPETESTA002"]);
    expect(scoped.rows[0]?.ageMinutes).toBe(120);
    expect(tooYoung.total).toBe(0);
    expect(tampered.total).toBe(0);
    expect(network.total).toBe(3);
  });

  test("transport enrichment selects the latest accepted scan and live trip ETA", async () => {
    const enriched = await transport.parcelAgingEnrichment(["scope_a_hold"]);
    expect(enriched.scope_a_hold?.lastScanAt?.getTime()).toBe((nowSeconds - 300) * 1000);
    expect(enriched.scope_a_hold?.lastScanBranchId).toBe(branchB);
    expect(enriched.scope_a_hold?.tripEta?.getTime()).toBe((nowSeconds + 3_600) * 1000);
  });

  test("global admin retains network-wide access while an optional branch filter narrows it", async () => {
    const [counts, stream, trends, runs] = await Promise.all([
      parcels.statusCounts(admin),
      parcels.listParcels({ page: 1, pageSize: 100 }, admin),
      parcels.parcelTrends(admin, 14, now),
      delivery.deliveryCounts(admin),
    ]);
    const narrowed = await parcels.listParcels({ page: 1, pageSize: 100, branchId: branchA }, admin);

    expect(counts.reduce((sum, row) => sum + row.count, 0)).toBe(3);
    expect(stream.total).toBe(3);
    expect(trends.totals.booked).toBe(3);
    expect(runs.runsheetsToday).toBe(2);
    expect(narrowed.total).toBe(2);
    expect(narrowed.rows.every((row) => row.branchId === branchA)).toBe(true);
  });
});
