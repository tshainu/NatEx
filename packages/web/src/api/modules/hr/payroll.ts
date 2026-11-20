import { and, asc, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { db } from "../../database";
import { hrApitSchedule, hrLeaveRequest, hrLeaveType, hrPayrollLine, hrPayrollRun } from "../../database/schema/hr";
import type { Principal } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { APIT_2026_27_PROVISIONAL, calculatePayroll, validateApitBands, type ApitBand, type ApitSchedule, type SalaryComponent } from "./calculations";
import { listEmployees, packageForPeriod, timesheetTotals } from "./service";
import { isValidIsoDate } from "./validation";

export type PayrollRunRow = typeof hrPayrollRun.$inferSelect;
export type PayrollLineRow = typeof hrPayrollLine.$inferSelect;

interface CalculationSnapshot {
  warnings: string[];
  lines: { label: string; kind: "earning" | "deduction"; amountCents: number }[];
  overtimeCents: number;
  manualApitReason?: string;
  apitScheduleVersion: string;
  apitScheduleBands: ApitBand[];
  time: { regularMinutes: number; overtimeMinutes: number };
  leave: { paidHalfDays: number; unpaidHalfDays: number; lastMonthPaidHalfDays: number; lastMonthUnpaidHalfDays: number };
  package: { code: string; name: string; payBasis: string };
  joinedOn: string;
  endedOn: string | null;
}

function daysInMonth(day: string): number {
  const [year, month] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month!, 0)).getUTCDate();
}

function daysInclusive(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function todayIso(): string { return new Date().toISOString().slice(0, 10); }

function overlap(fromA: string, toA: string, fromB: string, toB: string): { from: string; to: string } | null {
  const from = fromA > fromB ? fromA : fromB;
  const to = toA < toB ? toA : toB;
  return from <= to ? { from, to } : null;
}

/** Spread request half-days evenly over its date span; cumulative floors keep month allocations summing to the request total. */
function allocateRequestHalfDays(request: { startsOn: string; endsOn: string; halfDays: number }, from: string, to: string): number {
  const window = overlap(request.startsOn, request.endsOn, from, to);
  if (!window) return 0;
  const totalDays = daysInclusive(request.startsOn, request.endsOn);
  const beforeDays = daysInclusive(request.startsOn, window.from) - 1;
  const throughDays = beforeDays + daysInclusive(window.from, window.to);
  const floorPortion = (n: number) => Math.floor((request.halfDays * n) / totalDays);
  return floorPortion(throughDays) - floorPortion(beforeDays);
}

export async function ensureDefaultApitSchedule() {
  const [active] = await db.select().from(hrApitSchedule).where(and(
    eq(hrApitSchedule.taxYear, APIT_2026_27_PROVISIONAL.taxYear),
    ne(hrApitSchedule.status, "retired"),
  )).orderBy(desc(hrApitSchedule.createdAt)).limit(1);
  if (active) return active;
  const versions = await db.select({ version: hrApitSchedule.version }).from(hrApitSchedule).where(eq(hrApitSchedule.taxYear, APIT_2026_27_PROVISIONAL.taxYear));
  const revision = versions.length + 1;
  const id = versions.length === 0 ? APIT_2026_27_PROVISIONAL.id : prefixedId("has");
  const version = versions.length === 0 ? "provisional-v1" : `provisional-v${revision}`;
  await db.insert(hrApitSchedule).values({
    id,
    taxYear: APIT_2026_27_PROVISIONAL.taxYear,
    version,
    effectiveFrom: APIT_2026_27_PROVISIONAL.effectiveFrom,
    effectiveTo: APIT_2026_27_PROVISIONAL.effectiveTo,
    scheduleJson: JSON.stringify(APIT_2026_27_PROVISIONAL.bands),
    status: "unverified",
  }).onConflictDoNothing();
  const [schedule] = await db.select().from(hrApitSchedule).where(eq(hrApitSchedule.id, id));
  if (!schedule) throw new Error("The APIT schedule could not be initialized.");
  return schedule!;
}

export async function getApitSchedule() {
  return ensureDefaultApitSchedule();
}

function calculationSchedule(row: typeof hrApitSchedule.$inferSelect): ApitSchedule {
  let bands: ApitBand[];
  try {
    bands = JSON.parse(row.scheduleJson) as ApitBand[];
  } catch {
    errors.conflict(`The ${row.taxYear} APIT schedule contains invalid data; Finance/Admin must configure it again.`);
  }
  const invalid = validateApitBands(bands!);
  if (invalid) errors.conflict(`The ${row.taxYear} APIT schedule is invalid: ${invalid}`);
  return { id: row.id, taxYear: row.taxYear, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, bands: bands! };
}

export async function saveApitSchedule(input: { bands: ApitBand[] }) {
  const current = await ensureDefaultApitSchedule();
  const invalid = validateApitBands(input.bands);
  if (invalid) errors.badRequest(invalid);
  calculationSchedule(current);
  const scheduleJson = JSON.stringify(input.bands);
  if (scheduleJson === current.scheduleJson) return current;
  const revision = Number(current.version.match(/(\d+)$/)?.[1] ?? 1) + 1;
  const version = `accountant-v${revision}`;
  const nextId = prefixedId("has");
  await db.batch([
    db.insert(hrApitSchedule).values({
      id: nextId,
      taxYear: current.taxYear,
      version,
      effectiveFrom: current.effectiveFrom,
      effectiveTo: current.effectiveTo,
      scheduleJson,
      status: "unverified",
    }),
    db.update(hrApitSchedule).set({ status: "retired" }).where(eq(hrApitSchedule.id, current.id)),
  ]);
  const [next] = await db.select().from(hrApitSchedule).where(eq(hrApitSchedule.id, nextId));
  if (!next) throw new Error("The updated APIT schedule could not be loaded.");
  return next;
}

export async function validateApitSchedule(input: { accountantName: string; reference: string }, actor: Principal) {
  const schedule = await ensureDefaultApitSchedule();
  calculationSchedule(schedule);
  if (schedule.status !== "unverified") errors.conflict(`The ${schedule.taxYear} schedule is already ${schedule.status}; do not overwrite its validation record.`);
  if (input.accountantName.trim().length < 3 || input.reference.trim().length < 5) {
    errors.badRequest("Record the reviewing accountant's name and a supporting workpaper or reference before enabling APIT approval.");
  }
  const [row] = await db.update(hrApitSchedule).set({
    status: "validated",
    accountantName: input.accountantName.trim(),
    validationReference: input.reference.trim(),
    validatedBy: actor.userId,
    validatedAt: new Date(),
  }).where(eq(hrApitSchedule.id, schedule.id)).returning();
  return row!;
}

function periodFrom(input: { periodStart: string; periodEnd: string }): { days: number; codePart: string } {
  if (!isValidIsoDate(input.periodStart) || !isValidIsoDate(input.periodEnd)) errors.badRequest("Payroll period dates must be real calendar dates in YYYY-MM-DD format.");
  if (!/^\d{4}-\d{2}-01$/.test(input.periodStart)) errors.badRequest("Payroll runs must start on the first day of a calendar month.");
  const days = daysInMonth(input.periodStart);
  const expectedEnd = `${input.periodStart.slice(0, 7)}-${String(days).padStart(2, "0")}`;
  if (input.periodEnd !== expectedEnd) errors.badRequest(`Payroll must cover the full month through ${expectedEnd}.`);
  if (input.periodStart < APIT_2026_27_PROVISIONAL.effectiveFrom || input.periodEnd > APIT_2026_27_PROVISIONAL.effectiveTo) {
    errors.badRequest("This release is configured for the 2026/27 APIT period only. Do not run payroll outside those dates until the next tax-year schedule is installed and validated.");
  }
  return { days, codePart: input.periodStart.slice(0, 7).replace("-", "") };
}

async function approvedLeaveForPeriod(employeeId: string, from: string, to: string, cutoffDate = to) {
  const effectiveTo = cutoffDate < to ? cutoffDate : to;
  if (effectiveTo < from) return { paidHalfDays: 0, unpaidHalfDays: 0 };
  const rows = await db.select({
    request: hrLeaveRequest,
    paid: hrLeaveType.paid,
  }).from(hrLeaveRequest).innerJoin(hrLeaveType, eq(hrLeaveType.id, hrLeaveRequest.leaveTypeId)).where(and(
    eq(hrLeaveRequest.employeeId, employeeId),
    eq(hrLeaveRequest.status, "approved"),
    lte(hrLeaveRequest.startsOn, effectiveTo),
    gte(hrLeaveRequest.endsOn, from),
  ));
  let paidHalfDays = 0;
  let unpaidHalfDays = 0;
  for (const row of rows) {
    const units = allocateRequestHalfDays(row.request, from, effectiveTo);
    if (row.paid) paidHalfDays += units;
    else unpaidHalfDays += units;
  }
  return { paidHalfDays, unpaidHalfDays };
}

async function lateApprovedLeaveForPriorMonth(employeeId: string, periodStart: string, priorCutoffDate: string) {
  const priorMonthEnd = new Date(Date.parse(`${periodStart}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const priorMonthStart = `${priorMonthEnd.slice(0, 7)}-01`;
  const rows = await db.select({ request: hrLeaveRequest, paid: hrLeaveType.paid }).from(hrLeaveRequest).innerJoin(hrLeaveType, eq(hrLeaveType.id, hrLeaveRequest.leaveTypeId)).where(and(eq(hrLeaveRequest.employeeId, employeeId), eq(hrLeaveRequest.status, "approved"), lte(hrLeaveRequest.startsOn, priorMonthEnd), gte(hrLeaveRequest.endsOn, priorMonthStart)));
  let paidHalfDays = 0; let unpaidHalfDays = 0;
  for (const row of rows) {
    const approvedOn = row.request.decidedAt?.toISOString().slice(0, 10);
    if (!approvedOn || approvedOn <= priorCutoffDate) continue;
    const units = allocateRequestHalfDays(row.request, priorMonthStart, priorMonthEnd);
    if (row.paid) paidHalfDays += units; else unpaidHalfDays += units;
  }
  return { paidHalfDays, unpaidHalfDays };
}

function parseSnapshot(line: PayrollLineRow): CalculationSnapshot {
  return JSON.parse(line.breakdownJson) as CalculationSnapshot;
}

function blockedWarnings(lines: PayrollLineRow[]): string[] {
  const blocking: string[] = [];
  for (const line of lines) {
    const snapshot = parseSnapshot(line);
    for (const warning of snapshot.warnings) {
      if (/no overtime-pay rule|12-hour weekly|Automatic APIT is configured|Automatic monthly APIT was not applied/i.test(warning)) {
        blocking.push(`${line.employeeCode}: ${warning}`);
      }
    }
    if (line.netCents < 0) blocking.push(`${line.employeeCode}: net pay is negative.`);
  }
  return blocking;
}

export async function createPayrollRun(input: { periodStart: string; periodEnd: string; cutoffDate?: string; branchIds?: string[] }, actor: Principal) {
  const { days, codePart } = periodFrom(input);
  const cutoffDate = input.cutoffDate ?? todayIso();
  if (!isValidIsoDate(cutoffDate)) errors.badRequest("Salary-sheet cutoff date must be a real calendar date in YYYY-MM-DD format.");
  const existing = await db.select({ id: hrPayrollRun.id, status: hrPayrollRun.status }).from(hrPayrollRun).where(and(
    eq(hrPayrollRun.periodStart, input.periodStart),
    eq(hrPayrollRun.periodEnd, input.periodEnd),
    ne(hrPayrollRun.status, "cancelled"),
  )).limit(1);
  if (existing.length) errors.conflict(`A ${existing[0]!.status} payroll run already exists for this period.`);
  const schedule = await ensureDefaultApitSchedule();
  const apitSchedule = calculationSchedule(schedule);
  if (input.periodStart < schedule.effectiveFrom || input.periodEnd > schedule.effectiveTo) {
    errors.badRequest(`The installed APIT schedule does not cover ${input.periodStart} through ${input.periodEnd}.`);
  }
  const allEmployees = await listEmployees({ limit: 5000 });
  const selectedBranchIds = input.branchIds?.length ? new Set(input.branchIds) : null;
  const scopedEmployees = selectedBranchIds ? allEmployees.filter((employee) => selectedBranchIds.has(employee.branchId)) : allEmployees;
  const employees = scopedEmployees.filter((employee) =>
    employee.joinedOn <= input.periodEnd &&
    (employee.endedOn ? employee.endedOn >= input.periodStart : employee.status === "active"),
  );
  if (!employees.length) errors.badRequest("No active or period-overlapping employees were found for this payroll.");

  const prepared: {
    id: string;
    employee: typeof employees[number];
    result: ReturnType<typeof calculatePayroll>;
    snapshot: CalculationSnapshot;
  }[] = [];
  const missing: string[] = [];
  for (const employee of employees) {
    const employedFrom = employee.joinedOn > input.periodStart ? employee.joinedOn : input.periodStart;
    const employedTo = employee.endedOn && employee.endedOn < input.periodEnd ? employee.endedOn : input.periodEnd;
    const assignment = await packageForPeriod(employee.id, employedFrom, employedTo);
    if (!assignment) {
      missing.push(`${employee.employeeCode} (${employee.fullName})`);
      continue;
    }
    const [time, leave, previousRun] = await Promise.all([
      timesheetTotals(employee.id, employedFrom, employedTo),
      approvedLeaveForPeriod(employee.id, employedFrom, employedTo, cutoffDate),
      db.select({ cutoffDate: hrPayrollRun.cutoffDate }).from(hrPayrollRun).where(and(eq(hrPayrollRun.periodEnd, new Date(Date.parse(`${input.periodStart}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)), ne(hrPayrollRun.status, "cancelled"))).orderBy(desc(hrPayrollRun.createdAt)).limit(1),
    ]);
    const carry = previousRun[0] ? await lateApprovedLeaveForPriorMonth(employee.id, input.periodStart, previousRun[0].cutoffDate === "1970-01-01" ? `${input.periodStart.slice(0, 7)}-01` : previousRun[0].cutoffDate) : { paidHalfDays: 0, unpaidHalfDays: 0 };
    const totalLeave = { paidHalfDays: leave.paidHalfDays + carry.paidHalfDays, unpaidHalfDays: leave.unpaidHalfDays + carry.unpaidHalfDays };
    const employedDays = daysInclusive(employedFrom, employedTo);
    const nonEmploymentHalfDays = (days - employedDays) * 2;
    const payProrationHalfDays = nonEmploymentHalfDays + totalLeave.unpaidHalfDays;
    const components: SalaryComponent[] = assignment.package.items.map((item) => ({
      label: item.label,
      kind: item.kind as "earning" | "deduction",
      amountCents: item.amountCents,
      epfEligible: item.epfEligible,
      etfEligible: item.etfEligible,
      apitTaxable: item.apitTaxable,
      overtimeEligible: item.overtimeEligible,
      proration: item.proration as "full_period" | "unpaid_leave_prorated",
    }));
    const fullMonthEmployed = employedDays === days;
    const automaticApitEligible = fullMonthEmployed && assignment.package.payBasis === "monthly";
    const result = calculatePayroll({
      payBasis: assignment.package.payBasis as "monthly" | "daily" | "hourly",
      basePayCents: assignment.package.basePayCents,
      baseEpfEligible: assignment.package.baseEpfEligible,
      baseEtfEligible: assignment.package.baseEtfEligible,
      baseApitTaxable: assignment.package.baseApitTaxable,
      components,
      regularMinutes: time.regularMinutes,
      overtimeMinutes: time.overtimeMinutes,
      overtimeMinutesByWeek: time.overtimeMinutesByWeek,
      paidLeaveHalfDays: totalLeave.paidHalfDays,
      unpaidLeaveHalfDays: totalLeave.unpaidHalfDays,
      payProrationHalfDays,
      noPayLeaveHalfDays: totalLeave.unpaidHalfDays,
      periodDays: days,
      overtimePolicy: employee.overtimePolicy as "none" | "shop_office" | "custom",
      overtimeMultiplierBps: employee.overtimePolicy === "shop_office" ? 15_000 : employee.overtimeMultiplierBps,
      overtimeDivisorMinutes: employee.overtimeDivisorMinutes,
      primaryEmployment: employee.primaryEmployment,
      automaticApitEligible,
      apitSchedule,
    });
    const snapshot: CalculationSnapshot = {
      warnings: result.warnings,
      lines: result.lines,
      overtimeCents: result.overtimeCents,
      apitScheduleVersion: schedule.version,
      apitScheduleBands: apitSchedule.bands,
      time: { regularMinutes: time.regularMinutes, overtimeMinutes: time.overtimeMinutes },
      leave: { paidHalfDays: leave.paidHalfDays, unpaidHalfDays: leave.unpaidHalfDays, lastMonthPaidHalfDays: carry.paidHalfDays, lastMonthUnpaidHalfDays: carry.unpaidHalfDays },
      package: { code: assignment.package.code, name: assignment.package.name, payBasis: assignment.package.payBasis },
      joinedOn: employee.joinedOn,
      endedOn: employee.endedOn,
    };
    prepared.push({ id: prefixedId("hpl"), employee, result, snapshot });
  }
  if (missing.length) errors.conflict(`Assign a salary package covering the pay period to: ${missing.join(", ")}.`);

  const runId = prefixedId("hpr");
  const runCode = `PAY-${codePart}-${runId.slice(-6).toUpperCase()}`;
  const sums = prepared.reduce((acc, item) => ({
    grossCents: acc.grossCents + item.result.grossCents,
    employeeEpfCents: acc.employeeEpfCents + item.result.employeeEpfCents,
    employeeEtfCents: acc.employeeEtfCents + item.result.employeeEtfCents,
    employerEpfCents: acc.employerEpfCents + item.result.employerEpfCents,
    employerEtfCents: acc.employerEtfCents + item.result.employerEtfCents,
    apitCents: acc.apitCents + item.result.apitCents,
    otherDeductionsCents: acc.otherDeductionsCents + item.result.otherDeductionsCents,
    netCents: acc.netCents + item.result.netCents,
  }), { grossCents: 0, employeeEpfCents: 0, employeeEtfCents: 0, employerEpfCents: 0, employerEtfCents: 0, apitCents: 0, otherDeductionsCents: 0, netCents: 0 });
  await db.insert(hrPayrollRun).values({
    id: runId,
    code: runCode,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    cutoffDate,
    status: "draft",
    apitScheduleId: schedule.id,
    createdBy: actor.userId,
    employeeCount: prepared.length,
    ...sums,
  });
  try {
    for (const item of prepared) {
      await db.insert(hrPayrollLine).values({
        id: item.id,
        runId,
        employeeId: item.employee.id,
        employeeCode: item.employee.employeeCode,
        employeeName: item.employee.fullName,
        epfNumber: item.employee.epfNumber,
        payBasis: item.snapshot.package.payBasis,
        grossCents: item.result.grossCents,
        epfBaseCents: item.result.epfBaseCents,
        etfBaseCents: item.result.etfBaseCents,
        apitBaseCents: item.result.apitBaseCents,
        employeeEpfCents: item.result.employeeEpfCents,
        employeeEtfCents: item.result.employeeEtfCents,
        allowancesCents: item.result.lines.filter((line) => line.kind === "earning" && line.label !== "Base pay" && line.label !== "Overtime").reduce((sum, line) => sum + line.amountCents, 0),
        paidLeaveHalfDays: item.snapshot.leave.paidHalfDays,
        unpaidLeaveHalfDays: item.snapshot.leave.unpaidHalfDays,
        lastMonthLeaveHalfDays: item.snapshot.leave.lastMonthPaidHalfDays + item.snapshot.leave.lastMonthUnpaidHalfDays,
        employerEpfCents: item.result.employerEpfCents,
        employerEtfCents: item.result.employerEtfCents,
        apitCents: item.result.apitCents,
        otherDeductionsCents: item.result.otherDeductionsCents,
        netCents: item.result.netCents,
        breakdownJson: JSON.stringify(item.snapshot),
      });
    }
  } catch (error) {
    await db.delete(hrPayrollLine).where(eq(hrPayrollLine.runId, runId));
    await db.delete(hrPayrollRun).where(eq(hrPayrollRun.id, runId));
    throw error;
  }
  return getPayrollRun(runId, actor);
}

export async function listPayrollRuns(actor: Principal) {
  const rows = await db.select().from(hrPayrollRun).orderBy(desc(hrPayrollRun.periodStart), desc(hrPayrollRun.createdAt));
  const canSeeDrafts = actor.roles.includes("hr") || actor.roles.includes("admin");
  return rows.filter((row) => canSeeDrafts || (row.status !== "draft" && row.status !== "cancelled"));
}

export async function getPayrollRun(runId: string, actor: Principal) {
  const [run] = await db.select().from(hrPayrollRun).where(eq(hrPayrollRun.id, runId));
  if (!run) errors.notFound("Payroll run");
  const canSeeDrafts = actor.roles.includes("hr") || actor.roles.includes("admin");
  if (!canSeeDrafts && (run!.status === "draft" || run!.status === "cancelled")) errors.notFound("Payroll run");
  const lines = await db.select().from(hrPayrollLine).where(eq(hrPayrollLine.runId, runId)).orderBy(asc(hrPayrollLine.employeeCode));
  const [schedule] = await db.select().from(hrApitSchedule).where(eq(hrApitSchedule.id, run!.apitScheduleId));
  return { run: run!, lines, schedule: schedule ?? null };
}

export async function setManualApit(input: { runId: string; employeeId: string; amountCents: number; reason: string }, actor: Principal) {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) errors.badRequest("Manual APIT must be a non-negative whole number of cents.");
  if (input.reason.trim().length < 5) errors.badRequest("A reason or workpaper reference is required for manual APIT.");
  const [run] = await db.select().from(hrPayrollRun).where(eq(hrPayrollRun.id, input.runId));
  if (!run) errors.notFound("Payroll run");
  if (run!.status !== "draft") errors.conflict("Manual APIT can only be set on a draft payroll run.");
  const [line] = await db.select().from(hrPayrollLine).where(and(eq(hrPayrollLine.runId, input.runId), eq(hrPayrollLine.employeeId, input.employeeId)));
  if (!line) errors.notFound("Payroll line");
  const snapshot = parseSnapshot(line!);
  snapshot.warnings = snapshot.warnings.filter((warning) => !warning.startsWith("Automatic APIT is configured") && !warning.startsWith("Automatic monthly APIT was not applied") && !warning.startsWith("APIT was manually overridden"));
  snapshot.warnings.push(`APIT was manually overridden; supporting reference: ${input.reason.trim()}.`);
  snapshot.manualApitReason = input.reason.trim();
  const netCents = line!.grossCents - line!.employeeEpfCents - line!.employeeEtfCents - input.amountCents - line!.otherDeductionsCents;
  await db.update(hrPayrollLine).set({ apitCents: input.amountCents, netCents, breakdownJson: JSON.stringify(snapshot) }).where(eq(hrPayrollLine.id, line!.id));
  await refreshRunTotals(input.runId);
  return getPayrollRun(input.runId, actor);
}

async function refreshRunTotals(runId: string): Promise<void> {
  const lines = await db.select().from(hrPayrollLine).where(eq(hrPayrollLine.runId, runId));
  const sums = lines.reduce((acc, row) => ({
    grossCents: acc.grossCents + row.grossCents,
    employeeEpfCents: acc.employeeEpfCents + row.employeeEpfCents,
    employeeEtfCents: acc.employeeEtfCents + row.employeeEtfCents,
    employerEpfCents: acc.employerEpfCents + row.employerEpfCents,
    employerEtfCents: acc.employerEtfCents + row.employerEtfCents,
    apitCents: acc.apitCents + row.apitCents,
    otherDeductionsCents: acc.otherDeductionsCents + row.otherDeductionsCents,
    netCents: acc.netCents + row.netCents,
  }), { grossCents: 0, employeeEpfCents: 0, employeeEtfCents: 0, employerEpfCents: 0, employerEtfCents: 0, apitCents: 0, otherDeductionsCents: 0, netCents: 0 });
  await db.update(hrPayrollRun).set({ ...sums, employeeCount: lines.length }).where(eq(hrPayrollRun.id, runId));
}

export async function editDraftPayrollLine(input: { runId: string; employeeId: string; grossCents?: number; allowancesCents?: number; otherDeductionsCents?: number; paidLeaveHalfDays?: number; unpaidLeaveHalfDays?: number; apitCents?: number; employeeEtfCents?: number; reason: string }, actor: Principal) {
  if (input.reason.trim().length < 5) errors.badRequest("A reason is required for every payroll-line edit.");
  const [run] = await db.select().from(hrPayrollRun).where(eq(hrPayrollRun.id, input.runId));
  if (!run) errors.notFound("Payroll run");
  if (run!.status !== "draft") errors.conflict("Payroll lines are locked after submission or approval.");
  const [line] = await db.select().from(hrPayrollLine).where(and(eq(hrPayrollLine.runId, input.runId), eq(hrPayrollLine.employeeId, input.employeeId)));
  if (!line) errors.notFound("Payroll line");
  const values = [input.grossCents, input.allowancesCents, input.otherDeductionsCents, input.paidLeaveHalfDays, input.unpaidLeaveHalfDays, input.apitCents, input.employeeEtfCents].filter((v) => v !== undefined);
  if (!values.length) errors.badRequest("Provide at least one payroll amount or leave-day field to edit.");
  if (values.some((v) => !Number.isSafeInteger(v) || v! < 0)) errors.badRequest("Payroll edit values must be non-negative whole numbers.");
  const nextGross = input.grossCents ?? (input.allowancesCents === undefined ? line!.grossCents : line!.grossCents + input.allowancesCents - line!.allowancesCents);
  const nextOther = input.otherDeductionsCents ?? line!.otherDeductionsCents;
  const nextApit = input.apitCents ?? line!.apitCents;
  const nextEtf = input.employeeEtfCents ?? (input.grossCents === undefined ? line!.employeeEtfCents : Math.max(0, Math.round(line!.employeeEtfCents * nextGross / Math.max(1, line!.grossCents))));
  const snapshot = parseSnapshot(line!);
  snapshot.warnings = [...snapshot.warnings, `Draft payroll line edited by HR; reason: ${input.reason.trim()}.`];
  if (input.paidLeaveHalfDays !== undefined || input.unpaidLeaveHalfDays !== undefined) {
    snapshot.leave = { ...snapshot.leave, paidHalfDays: input.paidLeaveHalfDays ?? snapshot.leave.paidHalfDays, unpaidHalfDays: input.unpaidLeaveHalfDays ?? snapshot.leave.unpaidHalfDays };
  }
  const nextNet = nextGross - line!.employeeEpfCents - nextEtf - nextApit - nextOther;
  await db.update(hrPayrollLine).set({ grossCents: nextGross, allowancesCents: input.allowancesCents ?? line!.allowancesCents, otherDeductionsCents: nextOther, apitCents: nextApit, employeeEtfCents: nextEtf, paidLeaveHalfDays: input.paidLeaveHalfDays ?? line!.paidLeaveHalfDays, unpaidLeaveHalfDays: input.unpaidLeaveHalfDays ?? line!.unpaidLeaveHalfDays, netCents: nextNet, breakdownJson: JSON.stringify(snapshot) }).where(eq(hrPayrollLine.id, line!.id));
  await refreshRunTotals(input.runId);
  return getPayrollRun(input.runId, actor);
}

export async function approvePayrollLines(input: { runId: string; employeeIds: string[] }, actor: Principal) {
  const [run] = await db.select().from(hrPayrollRun).where(eq(hrPayrollRun.id, input.runId));
  if (!run) errors.notFound("Payroll run");
  if (run!.status !== "submitted") errors.conflict("Only submitted payroll lines can be approved.");
  if (run!.createdBy === actor.userId) errors.forbidden("A payroll maker cannot approve their own lines.");
  if (!input.employeeIds.length) errors.badRequest("Select at least one salary line.");
  await db.update(hrPayrollLine).set({ approvedBy: actor.userId, approvedAt: new Date() }).where(and(eq(hrPayrollLine.runId, input.runId), inArray(hrPayrollLine.employeeId, input.employeeIds)));
  return getPayrollRun(input.runId, actor);
}

export async function submitPayrollRun(runId: string, actor: Principal) {
  const detail = await getPayrollRun(runId, actor);
  if (detail.run.status !== "draft") errors.conflict(`Only draft payroll can be submitted; this run is ${detail.run.status}.`);
  if (!detail.schedule || detail.schedule.status === "retired" || detail.lines.some((line) => parseSnapshot(line).apitScheduleVersion !== detail.schedule!.version)) {
    errors.conflict("The APIT schedule changed after this draft was calculated. Cancel and recalculate the draft using the current schedule.");
  }
  const blockers = blockedWarnings(detail.lines);
  if (blockers.length) errors.conflict(`Resolve these payroll exceptions before submission: ${blockers.slice(0, 12).join("; ")}`);
  const [row] = await db.update(hrPayrollRun).set({ status: "submitted", submittedAt: new Date() }).where(eq(hrPayrollRun.id, runId)).returning();
  return row!;
}

export async function approvePayrollRun(runId: string, actor: Principal) {
  const detail = await getPayrollRun(runId, actor);
  if (detail.run.status !== "submitted") errors.conflict(`Only submitted payroll can be approved; this run is ${detail.run.status}.`);
  if (detail.run.createdBy === actor.userId) errors.forbidden("A payroll maker cannot approve their own run. A different Finance/Admin user must approve it.");
  if (!detail.schedule || detail.schedule.status !== "validated") errors.conflict("Finance/Admin cannot approve payroll until an accountant has validated the APIT schedule version used by this run.");
  if (detail.lines.some((line) => parseSnapshot(line).apitScheduleVersion !== detail.schedule!.version)) errors.conflict("The APIT schedule version does not match this payroll snapshot. Cancel and recalculate the draft.");
  const blockers = blockedWarnings(detail.lines);
  if (blockers.length) errors.conflict(`Resolve payroll exceptions before approval: ${blockers.slice(0, 12).join("; ")}`);
  const [row] = await db.update(hrPayrollRun).set({ status: "approved", approvedBy: actor.userId, approvedAt: new Date() }).where(eq(hrPayrollRun.id, runId)).returning();
  return row!;
}

export async function recordPayrollPayment(input: { runId: string; reference: string }, actor: Principal) {
  if (input.reference.trim().length < 3) errors.badRequest("Enter the bank transfer or payment reference.");
  const [run] = await db.select().from(hrPayrollRun).where(eq(hrPayrollRun.id, input.runId));
  if (!run) errors.notFound("Payroll run");
  if (run!.status !== "approved") errors.conflict("Only approved payroll marked ready to pay can be recorded as paid.");
  const [row] = await db.update(hrPayrollRun).set({
    status: "paid",
    paymentReference: input.reference.trim(),
    paidBy: actor.userId,
    paidAt: new Date(),
  }).where(eq(hrPayrollRun.id, input.runId)).returning();
  return row!;
}

export async function cancelDraftPayrollRun(input: { runId: string; reason: string }, actor: Principal) {
  if (input.reason.trim().length < 5) errors.badRequest("Give a reason for cancelling the draft payroll.");
  const [run] = await db.select().from(hrPayrollRun).where(eq(hrPayrollRun.id, input.runId));
  if (!run) errors.notFound("Payroll run");
  if (run!.status !== "draft") errors.conflict("Only a draft payroll run may be cancelled.");
  const [row] = await db.update(hrPayrollRun).set({ status: "cancelled", cancelledBy: actor.userId, cancelledAt: new Date(), cancelReason: input.reason.trim() }).where(eq(hrPayrollRun.id, input.runId)).returning();
  return row!;
}

export async function statutoryReport(runId: string, actor: Principal) {
  const detail = await getPayrollRun(runId, actor);
  if (detail.run.status !== "approved" && detail.run.status !== "paid") errors.conflict("Statutory reports are available only for approved payroll.");
  return {
    run: detail.run,
    schedule: detail.schedule,
    rows: detail.lines.map((line) => ({
      employeeCode: line.employeeCode,
      employeeName: line.employeeName,
      epfNumber: line.epfNumber,
      epfBaseCents: line.epfBaseCents,
      employeeEpfCents: line.employeeEpfCents,
      employeeEtfCents: line.employeeEtfCents,
      employerEpfCents: line.employerEpfCents,
      etfBaseCents: line.etfBaseCents,
      employerEtfCents: line.employerEtfCents,
      apitBaseCents: line.apitBaseCents,
      apitCents: line.apitCents,
      grossCents: line.grossCents,
      netCents: line.netCents,
    })),
  };
}
