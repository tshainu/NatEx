import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const path = join(tmpdir(), `natex-employee-login-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_URL = `file:${path}`;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";
process.env.SMS_DISABLE_ALL = "true";
delete process.env.SMS_EXECUTION_URL;

const { createClient } = await import("@libsql/client");
const setup = createClient({ url: process.env.DATABASE_URL });
await setup.execute(`CREATE TABLE identity_branch (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, address TEXT NOT NULL, phone TEXT,
  lat_e6 INTEGER, lng_e6 INTEGER, type TEXT NOT NULL, parent_hub_id TEXT REFERENCES identity_branch(id), status TEXT NOT NULL DEFAULT 'active',
  counter_rate_card_id TEXT, created_at INTEGER NOT NULL
)`);
await setup.execute(`CREATE TABLE identity_user (
  id TEXT PRIMARY KEY, branch_id TEXT, role TEXT, roles TEXT, username TEXT UNIQUE,
  password_hash TEXT, name TEXT, phone TEXT UNIQUE, device_id TEXT, status TEXT,
  merchant_id TEXT, created_at INTEGER
)`);
await setup.execute(`CREATE TABLE hr_employee (
  id TEXT PRIMARY KEY, employee_code TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
  identity_user_id TEXT, national_id TEXT, phone TEXT, email TEXT, address TEXT,
  branch_id TEXT NOT NULL, department TEXT NOT NULL, job_title TEXT NOT NULL,
  employment_type TEXT NOT NULL, joined_on TEXT NOT NULL, ended_on TEXT,
  status TEXT NOT NULL DEFAULT 'active', epf_number TEXT, tin TEXT,
  primary_employment INTEGER NOT NULL DEFAULT 1, overtime_policy TEXT NOT NULL DEFAULT 'none',
  overtime_multiplier_bps INTEGER NOT NULL DEFAULT 15000, overtime_divisor_minutes INTEGER NOT NULL DEFAULT 14400,
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`);
await setup.execute("CREATE UNIQUE INDEX hr_employee_identity_user_uq ON hr_employee(identity_user_id)");

const { db } = await import("../../database");
const { branch, user } = await import("../../database/schema/identity");
const { hrEmployee } = await import("../../database/schema/hr");
const { createBranch } = await import("./service");
const { createEmployeeLogin, listEmployeeLoginOptions } = await import("./admin");
const actor = {
  userId: "usr_employee_login_admin",
  name: "Employee login test admin",
  role: "admin" as const,
  roles: ["admin" as const],
  branchId: "test-branch",
};
const run = Date.now().toString(36);
let branchId = "";
let employeeId = "";
let createdUserId = "";

beforeAll(async () => {
  const createdBranch = await createBranch({
    code: `EL${Date.now().toString().slice(-8)}`,
    name: "Employee login test branch",
    address: "Test address, Colombo",
    type: "branch",
  });
  branchId = createdBranch!.id;
  employeeId = `emp_login_${run}`;
  await db.insert(hrEmployee).values({
    id: employeeId,
    employeeCode: `NTEST${run}`,
    fullName: "Unlinked Employee",
    identityUserId: null,
    phone: `077${Date.now().toString().slice(-7)}`,
    branchId,
    department: "Operations",
    jobTitle: "Courier",
    employmentType: "permanent",
    joinedOn: "2026-01-01",
    status: "active",
    primaryEmployment: true,
    overtimePolicy: "none",
    overtimeMultiplierBps: 15000,
    overtimeDivisorMinutes: 14400,
    createdBy: actor.userId,
    updatedBy: actor.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(hrEmployee).values({
    id: `emp_linked_${run}`,
    employeeCode: `NLINK${run}`,
    fullName: "Already Linked Employee",
    identityUserId: "usr_existing_link",
    phone: `078${Date.now().toString().slice(-7)}`,
    branchId,
    department: "Operations",
    jobTitle: "Courier",
    employmentType: "permanent",
    joinedOn: "2026-01-01",
    status: "active",
    primaryEmployment: true,
    overtimePolicy: "none",
    overtimeMultiplierBps: 15000,
    overtimeDivisorMinutes: 14400,
    createdBy: actor.userId,
    updatedBy: actor.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(hrEmployee).values({
    id: `emp_inactive_${run}`,
    employeeCode: `NINACT${run}`,
    fullName: "Inactive Employee",
    identityUserId: null,
    phone: `079${Date.now().toString().slice(-7)}`,
    branchId,
    department: "Operations",
    jobTitle: "Courier",
    employmentType: "permanent",
    joinedOn: "2026-01-01",
    status: "inactive",
    primaryEmployment: true,
    overtimePolicy: "none",
    overtimeMultiplierBps: 15000,
    overtimeDivisorMinutes: 14400,
    createdBy: actor.userId,
    updatedBy: actor.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(hrEmployee).where(eq(hrEmployee.branchId, branchId));
  if (createdUserId) await db.delete(user).where(eq(user.id, createdUserId));
  await db.delete(branch).where(eq(branch.id, branchId));
  setup.close();
  rmSync(path, { force: true });
});

describe("employee-first Admin login creation", () => {
  test("lists only active unlinked employees and excludes payroll fields", async () => {
    const options = await listEmployeeLoginOptions();
    expect(options.some((option) => option.id === employeeId)).toBe(true);
    expect(options.some((option) => option.employeeCode.startsWith("NLINK"))).toBe(false);
    expect(options.some((option) => option.employeeCode.startsWith("NINACT"))).toBe(false);
    expect(options[0]).not.toHaveProperty("salary");
    expect(options[0]).not.toHaveProperty("nationalId");
  });

  test("creates the login from employee fields and claims the employee atomically", async () => {
    const result = await createEmployeeLogin(actor, {
      employeeId,
      roles: ["rider", "ops"],
      username: `employee_${run}`,
      password: "employee-login-password",
    });
    createdUserId = result.user.id;
    expect(result.user.name).toBe("Unlinked Employee");
    expect(result.user.roles).toEqual(["rider", "ops"]);
    const [employee] = await db.select({ identityUserId: hrEmployee.identityUserId }).from(hrEmployee).where(eq(hrEmployee.id, employeeId));
    expect(employee?.identityUserId).toBe(createdUserId);
    await expect(createEmployeeLogin(actor, { employeeId, roles: ["rider"] })).rejects.toThrow("already linked");
  });

  test("rejects merchant roles even when the employee is eligible", async () => {
    const [employee] = await db.select({ identityUserId: hrEmployee.identityUserId }).from(hrEmployee).where(eq(hrEmployee.id, employeeId));
    expect(employee?.identityUserId).toBe(createdUserId);
    await expect(createEmployeeLogin(actor, { employeeId, roles: ["merchant"] })).rejects.toThrow("Merchant portal");
  });
});
