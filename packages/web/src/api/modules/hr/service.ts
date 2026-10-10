import { and, asc, desc, eq, gte, like, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../../database";
import {
  hrEmployee,
  hrEmployeePackage,
  hrPayrollRun,
  hrSalaryPackage,
  hrSalaryPackageItem,
  hrTimesheet,
} from "../../database/schema/hr";
import type { Principal } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { isValidIsoDate } from "./validation";

export type EmployeeRow = typeof hrEmployee.$inferSelect;
export type SalaryPackageRow = typeof hrSalaryPackage.$inferSelect;
export type SalaryPackageItemRow = typeof hrSalaryPackageItem.$inferSelect;
export type TimesheetRow = typeof hrTimesheet.$inferSelect;

export interface EmployeeInput {
  employeeCode: string;
  fullName: string;
  nationalId?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  branchId: string;
  department: string;
  jobTitle: string;
  employmentType: string;
  joinedOn: string;
  epfNumber?: string | null;
  tin?: string | null;
  primaryEmployment: boolean;
  overtimePolicy: "none" | "shop_office" | "custom";
  overtimeMultiplierBps: number;
  overtimeDivisorMinutes: number;
}

export interface PackageItemInput {
  label: string;
  kind: "earning" | "deduction";
  amountCents: number;
  epfEligible: boolean;
  etfEligible: boolean;
  apitTaxable: boolean;
  overtimeEligible: boolean;
  proration: "full_period" | "unpaid_leave_prorated";
}

export interface SalaryPackageInput {
  code: string;
  name: string;
  description?: string | null;
  payBasis: "monthly" | "daily" | "hourly";
  basePayCents: number;
  baseEpfEligible: boolean;
  baseEtfEligible: boolean;
  baseApitTaxable: boolean;
  items: PackageItemInput[];
}

function dateBefore(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function validateMoney(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) errors.badRequest(`${label} must be a non-negative whole number of cents.`);
}

export async function listEmployees(input: { q?: string; status?: string; limit?: number } = {}) {
  const filters = [];
  if (input.status) filters.push(eq(hrEmployee.status, input.status));
  if (input.q?.trim()) {
    const q = `%${input.q.trim().replace(/[%_]/g, "\\$&")}%`;
    filters.push(or(like(hrEmployee.employeeCode, q), like(hrEmployee.fullName, q), like(hrEmployee.department, q), like(hrEmployee.jobTitle, q))!);
  }
  let query = db.select().from(hrEmployee).orderBy(asc(hrEmployee.employeeCode)).$dynamic();
  if (filters.length) query = query.where(and(...filters));
  return query.limit(input.limit ?? 500);
}

export async function getEmployee(employeeId: string): Promise<EmployeeRow> {
  const [row] = await db.select().from(hrEmployee).where(eq(hrEmployee.id, employeeId));
  if (!row) errors.notFound("Employee");
  return row!;
}

export async function createEmployee(input: EmployeeInput, actor: Principal): Promise<EmployeeRow> {
  const code = input.employeeCode.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(code)) errors.badRequest("Employee code must be 2–20 letters, numbers, underscores or hyphens.");
  if (!isValidIsoDate(input.joinedOn)) errors.badRequest("Employee start date must be a real calendar date in YYYY-MM-DD format.");
  validateMoney(input.overtimeMultiplierBps, "Overtime multiplier");
  if (input.overtimeDivisorMinutes < 1 || !Number.isSafeInteger(input.overtimeDivisorMinutes)) {
    errors.badRequest("Overtime divisor must be a positive number of minutes.");
  }
  const [existing] = await db.select({ id: hrEmployee.id }).from(hrEmployee).where(eq(hrEmployee.employeeCode, code));
  if (existing) errors.conflict(`Employee code ${code} is already in use.`);
  const [row] = await db
    .insert(hrEmployee)
    .values({
      id: prefixedId("emp"),
      employeeCode: code,
      fullName: input.fullName.trim(),
      nationalId: input.nationalId?.trim() || null,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      address: input.address?.trim() || null,
      branchId: input.branchId,
      department: input.department.trim(),
      jobTitle: input.jobTitle.trim(),
      employmentType: input.employmentType,
      joinedOn: input.joinedOn,
      epfNumber: input.epfNumber?.trim() || null,
      tin: input.tin?.trim() || null,
      primaryEmployment: input.primaryEmployment,
      overtimePolicy: input.overtimePolicy,
      overtimeMultiplierBps: input.overtimeMultiplierBps,
      overtimeDivisorMinutes: input.overtimeDivisorMinutes,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    })
    .returning();
  return row!;
}

export async function updateEmployee(employeeId: string, patch: Partial<EmployeeInput> & { status?: "active" | "inactive"; endedOn?: string | null }, actor: Principal): Promise<EmployeeRow> {
  const before = await getEmployee(employeeId);
  const joinedOn = patch.joinedOn ?? before.joinedOn;
  const endedOn = patch.endedOn !== undefined ? patch.endedOn : before.endedOn;
  if (!isValidIsoDate(joinedOn)) errors.badRequest("Employee start date must be a real calendar date in YYYY-MM-DD format.");
  if (endedOn !== null && (!isValidIsoDate(endedOn) || endedOn < joinedOn)) errors.badRequest("Employee end date must be valid and on or after the start date.");
  const set: Partial<typeof hrEmployee.$inferInsert> = { updatedBy: actor.userId, updatedAt: new Date() };
  if (patch.employeeCode !== undefined) set.employeeCode = patch.employeeCode.trim().toUpperCase();
  if (patch.fullName !== undefined) set.fullName = patch.fullName.trim();
  if (patch.nationalId !== undefined) set.nationalId = patch.nationalId?.trim() || null;
  if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
  if (patch.email !== undefined) set.email = patch.email?.trim() || null;
  if (patch.address !== undefined) set.address = patch.address?.trim() || null;
  if (patch.branchId !== undefined) set.branchId = patch.branchId;
  if (patch.department !== undefined) set.department = patch.department.trim();
  if (patch.jobTitle !== undefined) set.jobTitle = patch.jobTitle.trim();
  if (patch.employmentType !== undefined) set.employmentType = patch.employmentType;
  if (patch.joinedOn !== undefined) set.joinedOn = patch.joinedOn;
  if (patch.endedOn !== undefined) set.endedOn = patch.endedOn;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.epfNumber !== undefined) set.epfNumber = patch.epfNumber?.trim() || null;
  if (patch.tin !== undefined) set.tin = patch.tin?.trim() || null;
  if (patch.primaryEmployment !== undefined) set.primaryEmployment = patch.primaryEmployment;
  if (patch.overtimePolicy !== undefined) set.overtimePolicy = patch.overtimePolicy;
  if (patch.overtimeMultiplierBps !== undefined) set.overtimeMultiplierBps = patch.overtimeMultiplierBps;
  if (patch.overtimeDivisorMinutes !== undefined) set.overtimeDivisorMinutes = patch.overtimeDivisorMinutes;
  if (patch.employeeCode !== undefined) {
    const code = set.employeeCode!;
    if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(code)) errors.badRequest("Employee code must be 2–20 letters, numbers, underscores or hyphens.");
    const [duplicate] = await db.select({ id: hrEmployee.id }).from(hrEmployee).where(and(eq(hrEmployee.employeeCode, code), ne(hrEmployee.id, employeeId)));
    if (duplicate) errors.conflict(`Employee code ${code} is already in use.`);
  }
  if (patch.overtimeMultiplierBps !== undefined) validateMoney(patch.overtimeMultiplierBps, "Overtime multiplier");
  if (patch.overtimeDivisorMinutes !== undefined && (patch.overtimeDivisorMinutes < 1 || !Number.isSafeInteger(patch.overtimeDivisorMinutes))) {
    errors.badRequest("Overtime divisor must be a positive number of minutes.");
  }
  const [row] = await db.update(hrEmployee).set(set).where(eq(hrEmployee.id, employeeId)).returning();
  return row ?? before;
}

export async function listSalaryPackages(activeOnly = false) {
  const packages = await db.select().from(hrSalaryPackage).orderBy(asc(hrSalaryPackage.code));
  const filtered = activeOnly ? packages.filter((p) => p.active) : packages;
  return Promise.all(filtered.map(async (pkg) => ({ ...pkg, items: await db.select().from(hrSalaryPackageItem).where(eq(hrSalaryPackageItem.packageId, pkg.id)).orderBy(asc(hrSalaryPackageItem.sortOrder)) })));
}

export async function getSalaryPackage(packageId: string) {
  const [pkg] = await db.select().from(hrSalaryPackage).where(eq(hrSalaryPackage.id, packageId));
  if (!pkg) errors.notFound("Salary package");
  const items = await db.select().from(hrSalaryPackageItem).where(eq(hrSalaryPackageItem.packageId, packageId)).orderBy(asc(hrSalaryPackageItem.sortOrder));
  return { ...pkg!, items };
}

function validateSalaryPackage(input: SalaryPackageInput): void {
  validateMoney(input.basePayCents, "Base pay");
  if (input.basePayCents === 0) errors.badRequest("Salary package base pay must be greater than zero.");
  if (input.items.length > 100) errors.badRequest("A salary package can contain at most 100 components.");
  const labels = new Set<string>();
  for (const item of input.items) {
    const label = item.label.trim().toLowerCase();
    if (!label || labels.has(label)) errors.badRequest("Salary package component labels must be present and unique.");
    labels.add(label);
    validateMoney(item.amountCents, `Component ${item.label}`);
    if (item.amountCents === 0) errors.badRequest(`Component ${item.label} must be greater than zero.`);
    if (item.kind === "deduction" && (item.epfEligible || item.etfEligible || item.apitTaxable || item.overtimeEligible)) {
      errors.badRequest(`Deduction ${item.label} cannot be included in a statutory or overtime earnings base.`);
    }
  }
}

function itemValues(packageId: string, items: PackageItemInput[]) {
  return items.map((item, index) => ({
    id: prefixedId("hpi"),
    packageId,
    label: item.label.trim(),
    kind: item.kind,
    amountCents: item.amountCents,
    epfEligible: item.epfEligible,
    etfEligible: item.etfEligible,
    apitTaxable: item.apitTaxable,
    overtimeEligible: item.overtimeEligible,
    proration: item.proration,
    sortOrder: index,
  }));
}

export async function createSalaryPackage(input: SalaryPackageInput, actor: Principal) {
  validateSalaryPackage(input);
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(code)) errors.badRequest("Package code must be 2–20 letters, numbers, underscores or hyphens.");
  const [existing] = await db.select({ id: hrSalaryPackage.id }).from(hrSalaryPackage).where(eq(hrSalaryPackage.code, code));
  if (existing) errors.conflict(`Salary package ${code} already exists.`);
  const id = prefixedId("hpk");
  await db.insert(hrSalaryPackage).values({
      id,
      code,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      payBasis: input.payBasis,
      basePayCents: input.basePayCents,
      baseEpfEligible: input.baseEpfEligible,
      baseEtfEligible: input.baseEtfEligible,
      baseApitTaxable: input.baseApitTaxable,
      createdBy: actor.userId,
    });
  for (const item of itemValues(id, input.items)) await db.insert(hrSalaryPackageItem).values(item);
  return getSalaryPackage(id);
}

export async function updateSalaryPackage(packageId: string, input: SalaryPackageInput) {
  validateSalaryPackage(input);
  const current = await getSalaryPackage(packageId);
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(code)) errors.badRequest("Package code must be 2–20 letters, numbers, underscores or hyphens.");
  const [duplicate] = await db.select({ id: hrSalaryPackage.id }).from(hrSalaryPackage).where(and(eq(hrSalaryPackage.code, code), ne(hrSalaryPackage.id, packageId)));
  if (duplicate) errors.conflict(`Salary package ${code} already exists.`);
  const assignments = await db.select({ id: hrEmployeePackage.id }).from(hrEmployeePackage).where(and(eq(hrEmployeePackage.packageId, packageId), or(sql`${hrEmployeePackage.effectiveTo} IS NULL`, gte(hrEmployeePackage.effectiveTo, new Date().toISOString().slice(0, 10)))));
  if (assignments.length > 0) errors.conflict("This package is assigned to employees. Create a new package version instead of editing an active package.");
  await db.update(hrSalaryPackage).set({
      code,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      payBasis: input.payBasis,
      basePayCents: input.basePayCents,
      baseEpfEligible: input.baseEpfEligible,
      baseEtfEligible: input.baseEtfEligible,
      baseApitTaxable: input.baseApitTaxable,
      updatedAt: new Date(),
    }).where(eq(hrSalaryPackage.id, packageId));
  await db.delete(hrSalaryPackageItem).where(eq(hrSalaryPackageItem.packageId, packageId));
  for (const item of itemValues(packageId, input.items)) await db.insert(hrSalaryPackageItem).values(item);
  return { ...current, ...await getSalaryPackage(packageId) };
}

export async function assignSalaryPackage(input: { employeeId: string; packageId: string; effectiveFrom: string }, actor: Principal) {
  if (!isValidIsoDate(input.effectiveFrom)) errors.badRequest("Package effective date must be a real calendar date in YYYY-MM-DD format.");
  const employee = await getEmployee(input.employeeId);
  if (input.effectiveFrom < employee.joinedOn) errors.badRequest("Salary package cannot take effect before the employee's start date.");
  const pkg = await getSalaryPackage(input.packageId);
  if (!pkg.active) errors.conflict("An inactive salary package cannot be assigned.");
  if (employee.status !== "active") errors.conflict("A salary package can only be assigned to an active employee.");
  const assignments = await db.select().from(hrEmployeePackage).where(eq(hrEmployeePackage.employeeId, input.employeeId)).orderBy(asc(hrEmployeePackage.effectiveFrom));
  const later = assignments.find((a) => a.effectiveFrom >= input.effectiveFrom);
  if (later?.effectiveFrom === input.effectiveFrom) errors.conflict("This employee already has a package effective on that date.");
  if (later) errors.conflict(`A future package is already scheduled from ${later.effectiveFrom}.`);
  const open = assignments.find((a) => a.effectiveTo === null || a.effectiveTo >= input.effectiveFrom);
  if (open) {
    if (open.effectiveFrom >= input.effectiveFrom) errors.conflict("Salary package effective dates overlap.");
    await db.update(hrEmployeePackage).set({ effectiveTo: dateBefore(input.effectiveFrom) }).where(eq(hrEmployeePackage.id, open.id));
  }
  const [row] = await db.insert(hrEmployeePackage).values({
    id: prefixedId("hpe"),
    employeeId: input.employeeId,
    packageId: input.packageId,
    effectiveFrom: input.effectiveFrom,
    createdBy: actor.userId,
  }).returning();
  return row!;
}

export async function listEmployeePackages(employeeId: string) {
  await getEmployee(employeeId);
  const assignments = await db.select().from(hrEmployeePackage).where(eq(hrEmployeePackage.employeeId, employeeId)).orderBy(desc(hrEmployeePackage.effectiveFrom));
  return Promise.all(assignments.map(async (assignment) => ({ assignment, package: await getSalaryPackage(assignment.packageId) })));
}

export async function packageForPeriod(employeeId: string, periodStart: string, periodEnd: string) {
  const [assignment] = await db.select().from(hrEmployeePackage).where(and(
    eq(hrEmployeePackage.employeeId, employeeId),
    lte(hrEmployeePackage.effectiveFrom, periodStart),
    or(sql`${hrEmployeePackage.effectiveTo} IS NULL`, gte(hrEmployeePackage.effectiveTo, periodEnd)),
  )).orderBy(desc(hrEmployeePackage.effectiveFrom)).limit(1);
  if (!assignment) return null;
  const pkg = await getSalaryPackage(assignment.packageId);
  if (!pkg.active) return null;
  return { assignment, package: pkg };
}

export interface TimesheetInput {
  employeeCode: string;
  workDate: string;
  regularMinutes: number;
  overtimeMinutes: number;
  attendanceStatus?: "present" | "absent" | "leave" | "off_duty";
  note?: string | null;
  source: "manual" | "excel";
}

async function assertTimesheetUnlocked(workDate: string): Promise<void> {
  const [run] = await db.select({ id: hrPayrollRun.id, status: hrPayrollRun.status }).from(hrPayrollRun).where(and(
    lte(hrPayrollRun.periodStart, workDate),
    gte(hrPayrollRun.periodEnd, workDate),
    ne(hrPayrollRun.status, "cancelled"),
  )).limit(1);
  if (run) errors.conflict(`Timesheets cannot be changed while payroll ${run.id} is ${run.status}. Cancel the draft run first if it must be corrected.`);
}

export async function saveTimesheets(rows: TimesheetInput[], actor: Principal) {
  if (rows.length === 0) errors.badRequest("No timesheet rows were supplied.");
  if (rows.length > 5000) errors.badRequest("A timesheet import can contain at most 5,000 rows.");
  const seen = new Set<string>();
  const employeeByCode = new Map<string, EmployeeRow>();
  const prepared: { employee: EmployeeRow; row: TimesheetInput; code: string }[] = [];
  for (const row of rows) {
    const code = row.employeeCode.trim().toUpperCase();
    const key = `${code}:${row.workDate}`;
    if (seen.has(key)) errors.badRequest(`The upload contains duplicate employee/date rows: ${key}.`);
    seen.add(key);
    if (!isValidIsoDate(row.workDate)) errors.badRequest(`Invalid timesheet date for ${code}.`);
    for (const [value, field] of [[row.regularMinutes, "regular hours"], [row.overtimeMinutes, "overtime hours"]] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 1440) errors.badRequest(`${field} for ${code} must be between 0 and 24 hours.`);
    }
    if (row.regularMinutes + row.overtimeMinutes > 1440) errors.badRequest(`Total recorded time for ${code} on ${row.workDate} exceeds 24 hours.`);
    let employee = employeeByCode.get(code);
    if (!employee) {
      const [found] = await db.select().from(hrEmployee).where(eq(hrEmployee.employeeCode, code));
      if (!found || found.status !== "active") errors.badRequest(`Active employee ${code} was not found.`);
      employee = found!;
      employeeByCode.set(code, employee);
    }
    if (row.workDate < employee.joinedOn || (employee.endedOn && row.workDate > employee.endedOn)) {
      errors.badRequest(`Timesheet date ${row.workDate} falls outside ${code}'s recorded employment dates.`);
    }
    await assertTimesheetUnlocked(row.workDate);
    prepared.push({ employee, row, code });
  }
  for (const { employee, row } of prepared) {
    await db.insert(hrTimesheet).values({
      id: prefixedId("hts"),
      employeeId: employee.id,
      workDate: row.workDate,
      regularMinutes: row.regularMinutes,
      overtimeMinutes: row.overtimeMinutes,
      attendanceStatus: row.attendanceStatus ?? "present",
      note: row.note?.trim() || null,
      source: row.source,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    }).onConflictDoUpdate({
      target: [hrTimesheet.employeeId, hrTimesheet.workDate],
      set: {
        regularMinutes: row.regularMinutes,
        overtimeMinutes: row.overtimeMinutes,
        attendanceStatus: row.attendanceStatus ?? "present",
        note: row.note?.trim() || null,
        source: row.source,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      },
    });
  }
  return { imported: rows.length, employees: employeeByCode.size };
}

export async function listTimesheets(input: { from: string; to: string; employeeId?: string }) {
  if (!isValidIsoDate(input.from) || !isValidIsoDate(input.to) || input.from > input.to) errors.badRequest("Timesheet filter must use valid dates and an end date on or after the start date.");
  const filters = [gte(hrTimesheet.workDate, input.from), lte(hrTimesheet.workDate, input.to)];
  if (input.employeeId) filters.push(eq(hrTimesheet.employeeId, input.employeeId));
  return db.select({
    id: hrTimesheet.id,
    employeeId: hrTimesheet.employeeId,
    employeeCode: hrEmployee.employeeCode,
    fullName: hrEmployee.fullName,
    workDate: hrTimesheet.workDate,
    regularMinutes: hrTimesheet.regularMinutes,
    overtimeMinutes: hrTimesheet.overtimeMinutes,
    attendanceStatus: hrTimesheet.attendanceStatus,
    note: hrTimesheet.note,
    source: hrTimesheet.source,
  }).from(hrTimesheet).innerJoin(hrEmployee, eq(hrEmployee.id, hrTimesheet.employeeId)).where(and(...filters)).orderBy(asc(hrTimesheet.workDate), asc(hrEmployee.employeeCode));
}

export async function timesheetTotals(employeeId: string, from: string, to: string) {
  const rows = await db.select({ workDate: hrTimesheet.workDate, regularMinutes: hrTimesheet.regularMinutes, overtimeMinutes: hrTimesheet.overtimeMinutes }).from(hrTimesheet).where(and(
    eq(hrTimesheet.employeeId, employeeId),
    gte(hrTimesheet.workDate, from),
    lte(hrTimesheet.workDate, to),
  ));
  const weekly = new Map<string, number>();
  let regularMinutes = 0;
  let overtimeMinutes = 0;
  for (const row of rows) {
    regularMinutes += row.regularMinutes;
    overtimeMinutes += row.overtimeMinutes;
    const date = new Date(`${row.workDate}T00:00:00Z`);
    const weekday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - weekday);
    const weekStart = date.toISOString().slice(0, 10);
    weekly.set(weekStart, (weekly.get(weekStart) ?? 0) + row.overtimeMinutes);
  }
  return { regularMinutes, overtimeMinutes, overtimeMinutesByWeek: [...weekly.values()] };
}
