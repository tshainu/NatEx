import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `natex-runsheet-eligibility-${process.pid}-${Date.now()}.sqlite`);
const databaseUrl = `file:${dbPath}`;
process.env.DATABASE_URL = databaseUrl;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";
process.env.SMS_DISABLE_ALL = "true";
delete process.env.SMS_EXECUTION_URL;

const { createClient } = await import("@libsql/client");
const setup = createClient({ url: databaseUrl });

for (const statement of [
  `CREATE TABLE identity_branch (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, address TEXT NOT NULL, phone TEXT,
    lat_e6 INTEGER, lng_e6 INTEGER, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    counter_rate_card_id TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE identity_user (
    id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, role TEXT NOT NULL, roles TEXT NOT NULL DEFAULT '',
    username TEXT, password_hash TEXT, name TEXT NOT NULL, phone TEXT NOT NULL,
    device_id TEXT, status TEXT NOT NULL DEFAULT 'active', merchant_id TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE delivery_runsheet (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, rider_id TEXT NOT NULL, rider_name TEXT NOT NULL,
    branch_id TEXT NOT NULL, hub_id TEXT NOT NULL, run_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', planned_count INTEGER NOT NULL DEFAULT 0,
    delivered_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0,
    cod_expected_cents INTEGER NOT NULL DEFAULT 0, cod_collected_cents INTEGER NOT NULL DEFAULT 0,
    freight_expected_cents INTEGER NOT NULL DEFAULT 0, freight_collected_cents INTEGER NOT NULL DEFAULT 0,
    route_method TEXT, route_distance_metres INTEGER, optimised_at INTEGER,
    dispatched_at INTEGER, closed_at INTEGER, created_at INTEGER NOT NULL, created_by_name TEXT
  )`,
]) {
  await setup.execute(statement);
}

const { listRiders } = await import("../identity/service");
const delivery = await import("./service");

const run = randomUUID().replaceAll("-", "").slice(0, 10);
const branchA = `brn_run_a_${run}`;
const branchB = `brn_run_b_${run}`;
const inactiveBranch = `brn_run_inactive_${run}`;
const actor = {
  userId: `usr_ops_${run}`,
  name: "Runsheet test ops",
  role: "ops" as const,
  roles: ["ops" as const],
  branchId: branchA,
  merchantId: null,
};

function user(id: string, name: string, branchId: string, role: string, roles: string[], status = "active") {
  return {
    id,
    branchId,
    role,
    roles: JSON.stringify(roles),
    name,
    phone: `+9477${id.slice(-8)}`,
    status,
  };
}

async function addBranch(id: string, name: string, status = "active") {
  await setup.execute({
    sql: "INSERT INTO identity_branch(id,code,name,address,type,status,created_at) VALUES(?,?,?,?,?,?,?)",
    args: [id, id, name, `${name} address`, "hub", status, Date.now()],
  });
}

async function addUser(row: ReturnType<typeof user>) {
  await setup.execute({
    sql: "INSERT INTO identity_user(id,branch_id,role,roles,name,phone,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
    args: [row.id, row.branchId, row.role, row.roles, row.name, row.phone, row.status, Date.now()],
  });
}

beforeAll(async () => {
  await addBranch(branchA, "Mannar Hub");
  await addBranch(branchB, "Colombo Hub");
  await addBranch(inactiveBranch, "Disabled Hub", "inactive");
  await addUser(user(`usr_dual_${run}`, "Dual-role rider", branchA, "ops", ["ops", "rider"]));
  await addUser(user(`usr_ops_only_${run}`, "Pure operations user", branchA, "ops", ["ops"]));
  await addUser(user(`usr_other_${run}`, "Other branch rider", branchB, "rider", ["rider"]));
  await addUser(user(`usr_disabled_${run}`, "Disabled rider", branchA, "rider", ["rider"], "suspended"));
  await addUser(user(`usr_inactive_branch_${run}`, "Inactive branch rider", inactiveBranch, "rider", ["rider"]));
});

afterAll(() => {
  setup.close();
  rmSync(dbPath, { force: true });
});

describe("runsheet rider eligibility", () => {
  test("lists and creates a rider whose assigned rider role is secondary to Operations", async () => {
    const dualId = `usr_dual_${run}`;
    expect((await listRiders(branchA)).map((row) => row.id)).toContain(dualId);

    const sheet = await delivery.createRunsheet(
      { riderId: dualId, runDate: "2026-11-08" },
      actor,
    );
    expect(sheet.riderId).toBe(dualId);
    expect(sheet.branchId).toBe(branchA);
  });

  test("rejects an Operations-only account as not a rider", async () => {
    await expect(
      delivery.createRunsheet(
        { riderId: `usr_ops_only_${run}`, runDate: "2026-11-09" },
        actor,
      ),
    ).rejects.toThrow("not a rider");
  });

  test("keeps the actor branch boundary for an otherwise eligible rider", async () => {
    await expect(
      delivery.createRunsheet(
        { riderId: `usr_other_${run}`, runDate: "2026-11-10" },
        actor,
      ),
    ).rejects.toThrow("another branch");
  });

  test("rejects a disabled rider account", async () => {
    await expect(
      delivery.createRunsheet(
        { riderId: `usr_disabled_${run}`, runDate: "2026-11-11" },
        actor,
      ),
    ).rejects.toThrow("account is suspended");
  });

  test("rejects a rider whose branch is inactive", async () => {
    const globalActor = { ...actor, role: "admin" as const, roles: ["admin" as const] };
    await expect(
      delivery.createRunsheet(
        { riderId: `usr_inactive_branch_${run}`, runDate: "2026-11-12" },
        globalActor,
      ),
    ).rejects.toThrow("inactive");
  });
});
