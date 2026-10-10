import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import { branch } from "../../database/schema/identity";
import {
  hrEmployee,
  hrEmployeePackage,
  hrApitSchedule,
  hrLeaveType,
  hrLeaveRequest,
  hrPayrollLine,
  hrPayrollRun,
  hrSalaryPackage,
  hrSalaryPackageItem,
  hrTimesheet,
} from "../../database/schema/hr";
import type { Principal } from "../../shared/auth";
import { createBranch } from "../identity/service";
import * as hr from "./service";
import * as leave from "./leave";
import * as payroll from "./payroll";

const RUN = Date.now().toString(36).toUpperCase();
const BRANCH_CODE = `H${RUN.slice(-8)}`;
const HR_ACTOR: Principal = {
  userId: `usr_hr_${RUN}`,
  name: "HR payroll test maker",
  role: "hr",
  roles: ["hr"],
  branchId: "",
};
const FINANCE_ACTOR: Principal = {
  userId: `usr_fin_${RUN}`,
  name: "Finance payroll test checker",
  role: "finance",
  roles: ["finance"],
  branchId: "",
};
let testBranchId: string | null = null;
let employeeId: string | null = null;
let secondaryEmployeeId: string | null = null;
let packageId: string | null = null;
const runIds: string[] = [];
let originalApitSchedules: (typeof hrApitSchedule.$inferSelect)[] = [];
let originalLeaveTypes: (typeof hrLeaveType.$inferSelect)[] = [];

beforeAll(async () => {
  originalApitSchedules = await db.select().from(hrApitSchedule);
  originalLeaveTypes = await db.select().from(hrLeaveType);
  await payroll.ensureDefaultApitSchedule();
  const createdBranch = await createBranch({
    code: BRANCH_CODE,
    name: "HR/payroll integration test branch",
    address: "Test address, Colombo",
    latE6: 6_927_100,
    lngE6: 79_861_200,
    type: "branch",
  });
  testBranchId = createdBranch!.id;
  HR_ACTOR.branchId = testBranchId;
  FINANCE_ACTOR.branchId = testBranchId;

  const employee = await hr.createEmployee({
    employeeCode: `P${RUN}`,
    fullName: "Primary payroll test employee",
    branchId: testBranchId,
    department: "Operations",
    jobTitle: "Coordinator",
    employmentType: "permanent",
    joinedOn: "2026-07-01",
    primaryEmployment: true,
    overtimePolicy: "shop_office",
    overtimeMultiplierBps: 15_000,
    overtimeDivisorMinutes: 14_400,
  }, HR_ACTOR);
  employeeId = employee.id;
  const secondary = await hr.createEmployee({
    employeeCode: `S${RUN}`,
    fullName: "Secondary payroll test employee",
    branchId: testBranchId,
    department: "Finance",
    jobTitle: "Clerk",
    employmentType: "permanent",
    joinedOn: "2026-07-01",
    primaryEmployment: false,
    overtimePolicy: "none",
    overtimeMultiplierBps: 15_000,
    overtimeDivisorMinutes: 14_400,
  }, HR_ACTOR);
  secondaryEmployeeId = secondary.id;

  const salaryPackage = await hr.createSalaryPackage({
    code: `PK${RUN}`,
    name: "Payroll integration test package",
    payBasis: "monthly",
    basePayCents: 25_000_000,
    baseEpfEligible: true,
    baseEtfEligible: true,
    baseApitTaxable: true,
    items: [
      {
        label: "Statutory allowance",
        kind: "earning",
        amountCents: 1_000_000,
        epfEligible: true,
        etfEligible: true,
        apitTaxable: true,
        overtimeEligible: false,
        proration: "unpaid_leave_prorated",
      },
      {
        label: "Loan recovery",
        kind: "deduction",
        amountCents: 500_000,
        epfEligible: false,
        etfEligible: false,
        apitTaxable: false,
        overtimeEligible: false,
        proration: "full_period",
      },
    ],
  }, HR_ACTOR);
  packageId = salaryPackage.id;
  await hr.assignSalaryPackage({ employeeId, packageId, effectiveFrom: "2026-07-01" }, HR_ACTOR);
  await hr.assignSalaryPackage({ employeeId: secondary.id, packageId, effectiveFrom: "2026-07-01" }, HR_ACTOR);

  const defaultTypes = await leave.listLeaveTypes();
  const annual = defaultTypes.find((item) => item.code === "ANNUAL")!;
  const unpaid = defaultTypes.find((item) => item.code === "UNPAID")!;
  await leave.saveLeaveType({
    id: annual.id,
    code: annual.code,
    name: annual.name,
    paid: true,
    annualEntitlementHalfDays: 20,
    active: true,
  });
  const annualRequest = await leave.createLeaveRequest({
    employeeId,
    leaveTypeId: annual.id,
    startsOn: "2026-07-20",
    endsOn: "2026-07-20",
    halfDays: 2,
    reason: "Test paid annual leave",
  }, HR_ACTOR);
  await leave.decideLeaveRequest({ requestId: annualRequest.id, decision: "approved", note: "Approved for integration test" }, HR_ACTOR);
  const unpaidRequest = await leave.createLeaveRequest({
    employeeId,
    leaveTypeId: unpaid.id,
    startsOn: "2026-07-21",
    endsOn: "2026-07-21",
    halfDays: 2,
    reason: "Test unpaid leave",
  }, HR_ACTOR);
  await leave.decideLeaveRequest({ requestId: unpaidRequest.id, decision: "approved", note: "Approved for integration test" }, HR_ACTOR);
  await hr.saveTimesheets([
    { employeeCode: employee.employeeCode, workDate: "2026-07-10", regularMinutes: 480, overtimeMinutes: 60, source: "manual" },
    { employeeCode: secondary.employeeCode, workDate: "2026-07-10", regularMinutes: 480, overtimeMinutes: 0, source: "manual" },
  ], HR_ACTOR);
});

afterAll(async () => {
  if (runIds.length) {
    await db.delete(hrPayrollLine).where(inArray(hrPayrollLine.runId, runIds));
    await db.delete(hrPayrollRun).where(inArray(hrPayrollRun.id, runIds));
  }
  if (employeeId || secondaryEmployeeId) {
    const ids = [employeeId, secondaryEmployeeId].filter((id): id is string => Boolean(id));
    await db.delete(hrTimesheet).where(inArray(hrTimesheet.employeeId, ids));
    await db.delete(hrLeaveRequest).where(inArray(hrLeaveRequest.employeeId, ids));
    await db.delete(hrEmployeePackage).where(inArray(hrEmployeePackage.employeeId, ids));
    await db.delete(hrEmployee).where(inArray(hrEmployee.id, ids));
  }
  if (packageId) {
    await db.delete(hrSalaryPackageItem).where(eq(hrSalaryPackageItem.packageId, packageId));
    await db.delete(hrSalaryPackage).where(eq(hrSalaryPackage.id, packageId));
  }
  const originalLeaveTypeIds = new Set(originalLeaveTypes.map((type) => type.id));
  const currentLeaveTypes = await db.select({ id: hrLeaveType.id }).from(hrLeaveType);
  for (const type of currentLeaveTypes) {
    if (!originalLeaveTypeIds.has(type.id)) await db.delete(hrLeaveType).where(eq(hrLeaveType.id, type.id));
  }
  for (const original of originalLeaveTypes) {
    await db.update(hrLeaveType).set({
      code: original.code,
      name: original.name,
      paid: original.paid,
      annualEntitlementHalfDays: original.annualEntitlementHalfDays,
      active: original.active,
      updatedAt: original.updatedAt,
    }).where(eq(hrLeaveType.id, original.id));
  }
  const originalScheduleIds = new Set(originalApitSchedules.map((schedule) => schedule.id));
  const currentSchedules = await db.select({ id: hrApitSchedule.id }).from(hrApitSchedule);
  for (const schedule of currentSchedules) {
    if (!originalScheduleIds.has(schedule.id)) await db.delete(hrApitSchedule).where(eq(hrApitSchedule.id, schedule.id));
  }
  for (const original of originalApitSchedules) {
    await db.update(hrApitSchedule).set({
      taxYear: original.taxYear,
      version: original.version,
      effectiveFrom: original.effectiveFrom,
      effectiveTo: original.effectiveTo,
      scheduleJson: original.scheduleJson,
      status: original.status,
      accountantName: original.accountantName,
      validationReference: original.validationReference,
      validatedBy: original.validatedBy,
      validatedAt: original.validatedAt,
    }).where(eq(hrApitSchedule.id, original.id));
  }
  if (testBranchId) await db.delete(branch).where(eq(branch.id, testBranchId));
});

describe("HR and payroll database workflow", () => {
  test("calculates statutory payroll, requires manual APIT for secondary employment, enforces maker-checker and locks time records", async () => {
    const balances = await leave.listLeaveBalances(2026, employeeId!);
    const annual = balances.find((row) => row.leaveType === "Annual leave")!;
    expect(annual.entitlementHalfDays).toBe(20);
    expect(annual.usedHalfDays).toBe(2);
    expect(annual.availableHalfDays).toBe(18);

    const draft = await payroll.createPayrollRun({ periodStart: "2026-07-01", periodEnd: "2026-07-31" }, HR_ACTOR);
    runIds.push(draft.run.id);
    expect(draft.run.status).toBe("draft");
    expect(draft.lines).toHaveLength(2);
    const primary = draft.lines.find((line) => line.employeeId === employeeId)!;
    const secondary = draft.lines.find((line) => line.employeeId === secondaryEmployeeId)!;

    expect(primary.grossCents).toBe(25_317_540);
    expect(primary.epfBaseCents).toBe(primary.grossCents);
    expect(primary.employeeEpfCents).toBe(2_025_403);
    expect(primary.employerEpfCents).toBe(3_038_105);
    expect(primary.employerEtfCents).toBe(759_526);
    expect(primary.apitCents).toBe(857_157);
    expect(primary.otherDeductionsCents).toBe(500_000);
    expect(primary.netCents).toBe(21_934_980);
    expect(secondary.apitCents).toBe(0);
    expect(secondary.breakdownJson).toContain("secondary employment");

    await expect(hr.saveTimesheets([
      { employeeCode: `P${RUN}`, workDate: "2026-07-10", regularMinutes: 480, overtimeMinutes: 0, source: "manual" },
    ], HR_ACTOR)).rejects.toThrow("Timesheets cannot be changed");

    await expect(payroll.submitPayrollRun(draft.run.id, HR_ACTOR)).rejects.toThrow("Automatic APIT is configured");
    await payroll.setManualApit({ runId: draft.run.id, employeeId: secondary.employeeId, amountCents: 1_000_000, reason: "Accountant workpaper APIT-2026-07" }, HR_ACTOR);
    await payroll.submitPayrollRun(draft.run.id, HR_ACTOR);
    await expect(payroll.approvePayrollRun(draft.run.id, { ...FINANCE_ACTOR, userId: HR_ACTOR.userId })).rejects.toThrow("maker cannot approve");

    const schedule = await payroll.validateApitSchedule({ accountantName: "Integration Test Accountant", reference: "APIT-2026-27-review-v1" }, FINANCE_ACTOR);
    expect(schedule.status).toBe("validated");
    const approved = await payroll.approvePayrollRun(draft.run.id, FINANCE_ACTOR);
    expect(approved.status).toBe("approved");
    const paid = await payroll.recordPayrollPayment({ runId: draft.run.id, reference: "TEST-BANK-UTR-001" }, FINANCE_ACTOR);
    expect(paid.status).toBe("paid");
    expect(paid.paymentReference).toBe("TEST-BANK-UTR-001");
    const report = await payroll.statutoryReport(draft.run.id, FINANCE_ACTOR);
    expect(report.rows.find((row) => row.employeeCode === `P${RUN}`)?.employeeEpfCents).toBe(2_025_403);
  });

  test("cancels a draft without deleting history and allows a replacement run for that month", async () => {
    const first = await payroll.createPayrollRun({ periodStart: "2026-08-01", periodEnd: "2026-08-31" }, HR_ACTOR);
    runIds.push(first.run.id);
    const cancelled = await payroll.cancelDraftPayrollRun({ runId: first.run.id, reason: "Correct source timesheet for test" }, HR_ACTOR);
    expect(cancelled.status).toBe("cancelled");
    const replacement = await payroll.createPayrollRun({ periodStart: "2026-08-01", periodEnd: "2026-08-31" }, HR_ACTOR);
    runIds.push(replacement.run.id);
    expect(replacement.run.id).not.toBe(first.run.id);
    expect(replacement.run.status).toBe("draft");
  });

  test("creates a new unverified APIT schedule version, preserves old history and blocks stale drafts", async () => {
    const staleDraft = await payroll.createPayrollRun({ periodStart: "2026-10-01", periodEnd: "2026-10-31" }, HR_ACTOR);
    runIds.push(staleDraft.run.id);
    const current = await payroll.getApitSchedule();
    const bands = JSON.parse(current.scheduleJson) as { maxMonthlyCents: number | null; rateBps: number; offsetCents: number }[];
    bands[2] = { ...bands[2]!, offsetCents: bands[2]!.offsetCents + 100 };
    const revised = await payroll.saveApitSchedule({ bands });
    expect(revised.id).not.toBe(current.id);
    expect(revised.version).not.toBe(current.version);
    expect(revised.status).toBe("unverified");
    const [previous] = await db.select().from(hrApitSchedule).where(eq(hrApitSchedule.id, current.id));
    expect(previous.status).toBe("retired");
    expect(previous.accountantName).toBe("Integration Test Accountant");
    expect(previous.scheduleJson).toBe(current.scheduleJson);
    await expect(payroll.submitPayrollRun(staleDraft.run.id, HR_ACTOR)).rejects.toThrow("APIT schedule changed");
  });
});
