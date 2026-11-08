import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import type { Principal } from "../../shared/auth";

const path = join(tmpdir(), `natex-hr-salary-atomic-${process.pid}-${Date.now()}.sqlite`);
process.env.DATABASE_URL = `file:${path}`;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";

const setup = createClient({ url: process.env.DATABASE_URL });
await setup.execute(`CREATE TABLE identity_user (
  id TEXT PRIMARY KEY, branch_id TEXT, role TEXT, roles TEXT, username TEXT,
  password_hash TEXT, name TEXT, phone TEXT, device_id TEXT, status TEXT,
  merchant_id TEXT, created_at INTEGER
)`);
await setup.execute(`CREATE TABLE hr_employee (
  id TEXT PRIMARY KEY, employee_code TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
  identity_user_id TEXT, national_id TEXT, phone TEXT, email TEXT, address TEXT,
  branch_id TEXT NOT NULL, department TEXT NOT NULL, job_title TEXT NOT NULL,
  employment_type TEXT NOT NULL, joined_on TEXT NOT NULL, ended_on TEXT,
  status TEXT NOT NULL DEFAULT 'active', epf_number TEXT, tin TEXT,
  primary_employment INTEGER NOT NULL DEFAULT 1, overtime_policy TEXT NOT NULL DEFAULT 'none',
  overtime_multiplier_bps INTEGER NOT NULL DEFAULT 15000,
  overtime_divisor_minutes INTEGER NOT NULL DEFAULT 14400,
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);
await setup.execute(`CREATE TABLE hr_salary_package (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT,
  pay_basis TEXT NOT NULL DEFAULT 'monthly', base_pay_cents INTEGER NOT NULL,
  base_epf_eligible INTEGER NOT NULL DEFAULT 1, base_etf_eligible INTEGER NOT NULL DEFAULT 1,
  base_apit_taxable INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`);
await setup.execute(`CREATE TABLE hr_salary_package_item (
  id TEXT PRIMARY KEY, package_id TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, epf_eligible INTEGER NOT NULL DEFAULT 0,
  etf_eligible INTEGER NOT NULL DEFAULT 0, apit_taxable INTEGER NOT NULL DEFAULT 0,
  overtime_eligible INTEGER NOT NULL DEFAULT 0,
  proration TEXT NOT NULL DEFAULT 'full_period', sort_order INTEGER NOT NULL DEFAULT 0
)`);
await setup.execute(`CREATE TABLE hr_employee_package (
  id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, package_id TEXT NOT NULL,
  effective_from TEXT NOT NULL, effective_to TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
)`);
await setup.execute(`CREATE TABLE shared_audit_log (
  id TEXT PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
  actor_id TEXT, actor_role TEXT, branch_id TEXT, device_id TEXT, request_id TEXT,
  before_json TEXT, after_json TEXT, ts INTEGER NOT NULL
)`);

const { db } = await import("../../database");
const { auditLog } = await import("../../database/schema/shared");
const { hrEmployeePackage } = await import("../../database/schema/hr");
const hr = await import("./service");

const RUN = Date.now().toString(36).toUpperCase();
const actor: Principal = {
  userId: `usr_hr_salary_atomic_${RUN}`,
  name: "Atomic salary HR test",
  role: "hr",
  roles: ["hr"],
  branchId: `branch_${RUN}`,
};

const packageInput = (code: string, name: string, basePayCents: number) => ({
  code,
  name,
  payBasis: "monthly" as const,
  basePayCents,
  baseEpfEligible: true,
  baseEtfEligible: true,
  baseApitTaxable: true,
  items: [],
});

let employeeId = "";
let firstPackageId = "";
let secondPackageId = "";

afterAll(() => {
  setup.close();
  rmSync(path, { force: true });
});

describe("atomic HR employee and salary save", () => {
  test("rolls back the profile when salary validation fails", async () => {
    const employee = await hr.createEmployee({
      fullName: "Atomic salary test employee",
      branchId: actor.branchId,
      department: "Operations",
      jobTitle: "Coordinator",
      employmentType: "permanent",
      joinedOn: "2026-07-01",
      primaryEmployment: true,
      overtimePolicy: "none",
      overtimeMultiplierBps: 15_000,
      overtimeDivisorMinutes: 14_400,
    }, actor);
    employeeId = employee.id;
    const salaryPackage = await hr.createSalaryPackage(packageInput(`AT${RUN}`, "Atomic salary package", 12_500_050), actor);
    firstPackageId = salaryPackage.id;

    await expect(hr.updateEmployeeWithSalary(
      employee.id,
      { fullName: "This name must roll back" },
      { packageId: "missing-package", effectiveFrom: "2026-08-01" },
      actor,
      `req-${RUN}-invalid-package`,
    )).rejects.toThrow("Salary package");

    await expect(hr.updateEmployeeWithSalary(
      employee.id,
      { fullName: "This date must also roll back" },
      { packageId: salaryPackage.id, effectiveFrom: "2026-06-30" },
      actor,
      `req-${RUN}-invalid-date`,
    )).rejects.toThrow("before the employee's start date");

    const unchanged = await hr.getEmployee(employee.id);
    expect(unchanged.fullName).toBe("Atomic salary test employee");
    expect(await hr.listEmployeePackages(employee.id)).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.entityId, employee.id))).toHaveLength(0);
  });

  test("commits profile, salary history, cents package reference, and one audit row together", async () => {
    const secondPackage = await hr.createSalaryPackage(packageInput(`AU${RUN}`, "Atomic salary replacement", 15_000_000), actor);
    secondPackageId = secondPackage.id;
    await hr.assignSalaryPackage({ employeeId, packageId: firstPackageId, effectiveFrom: "2026-07-01" }, actor);

    const saved = await hr.updateEmployeeWithSalary(
      employeeId,
      { fullName: "Atomic salary test employee updated", department: "People Operations" },
      { packageId: secondPackageId, effectiveFrom: "2026-08-01" },
      actor,
      `req-${RUN}-valid`,
    );

    expect(saved.fullName).toBe("Atomic salary test employee updated");
    expect(saved.salaryAssignment?.packageId).toBe(secondPackageId);
    expect(saved.salaryAssignment?.effectiveFrom).toBe("2026-08-01");

    const history = await db.select().from(hrEmployeePackage)
      .where(eq(hrEmployeePackage.employeeId, employeeId))
      .orderBy(hrEmployeePackage.effectiveFrom);
    expect(history).toHaveLength(2);
    expect(history[0]?.packageId).toBe(firstPackageId);
    expect(history[0]?.effectiveTo).toBe("2026-07-31");
    expect(history[1]?.packageId).toBe(secondPackageId);
    expect(secondPackage.basePayCents).toBe(15_000_000);

    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, employeeId));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("hr.employee_updated");
    expect(audits[0]?.requestId).toBe(`req-${RUN}-valid`);
    expect(audits[0]?.afterJson).toContain("Atomic salary test employee updated");
  });
});
