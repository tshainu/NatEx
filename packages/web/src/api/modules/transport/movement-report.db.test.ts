import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

const path = join(tmpdir(), `natex-movement-report-${process.pid}-${Date.now()}.sqlite`);
const databaseUrl = `file:${path}`;
process.env.DATABASE_URL = databaseUrl;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";
process.env.SMS_DISABLE_ALL = "true";
delete process.env.SMS_EXECUTION_URL;
const { createClient } = await import("@libsql/client");
const setup = createClient({ url: databaseUrl });
await setup.execute(`CREATE TABLE identity_branch (
 id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, address TEXT NOT NULL, phone TEXT,
 lat_e6 INTEGER, lng_e6 INTEGER, type TEXT NOT NULL, parent_hub_id TEXT, status TEXT NOT NULL DEFAULT 'active',
 counter_rate_card_id TEXT, created_at INTEGER NOT NULL
)`);
await setup.execute(`CREATE TABLE transport_hub_scan (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, awb TEXT, parcel_id TEXT, bag_id TEXT, trip_id TEXT,
 branch_id TEXT NOT NULL, hub_id TEXT, outcome TEXT NOT NULL, reason TEXT, actor_id TEXT, actor_name TEXT,
 actor_role TEXT, device_id TEXT, lat_e6 INTEGER, lng_e6 INTEGER, client_id TEXT, ts INTEGER NOT NULL
)`);
await setup.execute("CREATE TABLE transport_bag (id TEXT PRIMARY KEY, code TEXT NOT NULL)");
await setup.execute("CREATE TABLE transport_trip (id TEXT PRIMARY KEY, code TEXT NOT NULL)");
const transport = await import("./service");
const admin = {
  userId: "test_admin",
  name: "Test Admin",
  role: "admin" as const,
  roles: ["admin" as const],
  branchId: "hub_a",
  merchantId: null,
};
const ops = {
  ...admin,
  userId: "test_ops",
  role: "ops" as const,
  roles: ["ops" as const],
};
const from = "2026-11-13";
const to = "2026-11-13";
const startUtc = new Date("2026-11-12T18:30:00.000Z");
const endUtc = new Date("2026-11-13T18:30:00.000Z");
const epochSeconds = (date: Date) => Math.floor(date.getTime() / 1_000);

await setup.execute({
  sql: `INSERT INTO identity_branch (id, code, name, address, type, parent_hub_id, created_at) VALUES
    ('hub_a', 'HUBA', 'Hub A', 'A', 'hub', NULL, 0),
    ('child_a', 'CHDA', 'Child A', 'A', 'branch', 'hub_a', 0),
    ('hub_b', 'HUBB', 'Hub B', 'B', 'hub', NULL, 0),
    ('child_b', 'CHDB', 'Child B', 'B', 'branch', 'hub_b', 0)`,
});
await setup.execute("INSERT INTO transport_bag (id, code) VALUES ('bag_1', 'BG001')");
await setup.execute("INSERT INTO transport_trip (id, code) VALUES ('trip_1', 'TR001')");
await setup.execute({
  sql: `INSERT INTO transport_hub_scan
    (id, kind, awb, bag_id, trip_id, branch_id, hub_id, outcome, reason, actor_id, actor_name, lat_e6, lng_e6, ts)
    VALUES (?, 'bag_in', 'NX001', 'bag_1', 'trip_1', 'hub_a', 'hub_a', 'accepted', 'logged', 'private-id', 'Private Name', 123456, 654321, ?),
           (?, 'bag_out', 'NX002', NULL, NULL, 'child_a', 'hub_a', 'rejected', 'outside boundary test', NULL, NULL, NULL, NULL, ?),
           (?, 'trip_load', NULL, 'bag_1', 'trip_1', 'hub_b', 'hub_b', 'accepted', NULL, NULL, NULL, NULL, NULL, ?),
           (?, 'parcel_in', 'NX004', NULL, NULL, 'hub_a', 'hub_a', 'accepted', NULL, NULL, NULL, NULL, NULL, ?)`,
  args: [
    "scan_start", epochSeconds(startUtc),
    "scan_child", epochSeconds(new Date(startUtc.getTime() + 60_000)),
    "scan_other", epochSeconds(new Date(startUtc.getTime() + 60_000)),
    "scan_end", epochSeconds(endUtc),
  ],
});

afterAll(() => {
  setup.close();
  rmSync(path, { force: true });
});

describe("Hub & Bag Movement report (isolated SQLite)", () => {
  test("uses inclusive Colombo dates and returns only report-safe facts", async () => {
    const result = await transport.movementReport(
      { from, to, page: 1, pageSize: 25 },
      admin,
    );
    expect(result.total).toBe(3);
    expect(result.rows.map((row) => row.id)).toContain("scan_start");
    expect(result.rows.map((row) => row.id)).not.toContain("scan_end");
    expect(result.rows.find((row) => row.id === "scan_start")).toMatchObject({
      awb: "NX001",
      bagCode: "BG001",
      tripCode: "TR001",
      branchName: "HUBA · Hub A",
      hubName: "HUBA · Hub A",
    });
    expect(result.rows[0]).not.toHaveProperty("lat");
    expect(result.rows[0]).not.toHaveProperty("lng");
    expect(result.rows[0]).not.toHaveProperty("actorId");
    expect(result.rows[0]).not.toHaveProperty("actorName");
  });

  test("Ops is scoped to its assigned hub and direct children; filters narrow only", async () => {
    const scoped = await transport.movementReport(
      { from, to, page: 1, pageSize: 25 },
      ops,
    );
    expect(scoped.rows.map((row) => row.id)).toEqual(["scan_child", "scan_start"]);
    const narrowed = await transport.movementReport(
      { from, to, branchId: "child_a", page: 1, pageSize: 25 },
      ops,
    );
    expect(narrowed.rows.map((row) => row.id)).toEqual(["scan_child"]);
    await expect(
      transport.movementReport({ from, to, hubId: "hub_b", page: 1, pageSize: 25 }, ops),
    ).rejects.toThrow("assigned branch/hub");
  });
});
