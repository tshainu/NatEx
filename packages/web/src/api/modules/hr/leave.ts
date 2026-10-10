import { and, asc, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { db } from "../../database";
import { hrEmployee, hrLeaveAdjustment, hrLeaveRequest, hrLeaveType } from "../../database/schema/hr";
import type { Principal } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { getEmployee } from "./service";
import { isValidIsoDate } from "./validation";

export type LeaveTypeRow = typeof hrLeaveType.$inferSelect;
export type LeaveRequestRow = typeof hrLeaveRequest.$inferSelect;

const DEFAULT_LEAVE_TYPES = [
  { code: "ANNUAL", name: "Annual leave", paid: true },
  { code: "CASUAL", name: "Casual leave", paid: true },
  { code: "SICK", name: "Medical leave", paid: true },
  { code: "UNPAID", name: "Unpaid leave", paid: false },
] as const;

/** Seed labels only. Entitlements remain zero until HR configures NatEx policy. */
export async function ensureDefaultLeaveTypes(): Promise<void> {
  for (const item of DEFAULT_LEAVE_TYPES) {
    await db.insert(hrLeaveType).values({
      id: `hlt_${item.code.toLowerCase()}`,
      code: item.code,
      name: item.name,
      paid: item.paid,
      annualEntitlementHalfDays: 0,
      active: true,
    }).onConflictDoNothing();
  }
}

export async function listLeaveTypes() {
  await ensureDefaultLeaveTypes();
  return db.select().from(hrLeaveType).orderBy(asc(hrLeaveType.name));
}

export async function saveLeaveType(input: {
  id?: string;
  code: string;
  name: string;
  paid: boolean;
  annualEntitlementHalfDays: number;
  active: boolean;
}) {
  if (!Number.isSafeInteger(input.annualEntitlementHalfDays) || input.annualEntitlementHalfDays < 0) {
    errors.badRequest("Leave entitlement must be a non-negative number of half-days.");
  }
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) errors.badRequest("Leave code must be 2–20 letters, numbers, underscores or hyphens.");
  if (input.id) {
    const [current] = await db.select().from(hrLeaveType).where(eq(hrLeaveType.id, input.id));
    if (!current) errors.notFound("Leave type");
    const [duplicate] = await db.select({ id: hrLeaveType.id }).from(hrLeaveType).where(and(eq(hrLeaveType.code, code), ne(hrLeaveType.id, input.id)));
    if (duplicate) errors.conflict(`Leave code ${code} already exists.`);
    const [row] = await db.update(hrLeaveType).set({
      code,
      name: input.name.trim(),
      paid: input.paid,
      annualEntitlementHalfDays: input.annualEntitlementHalfDays,
      active: input.active,
      updatedAt: new Date(),
    }).where(eq(hrLeaveType.id, input.id)).returning();
    return row!;
  }
  const [duplicate] = await db.select({ id: hrLeaveType.id }).from(hrLeaveType).where(eq(hrLeaveType.code, code));
  if (duplicate) errors.conflict(`Leave code ${code} already exists.`);
  const [row] = await db.insert(hrLeaveType).values({
    id: prefixedId("hlt"),
    code,
    name: input.name.trim(),
    paid: input.paid,
    annualEntitlementHalfDays: input.annualEntitlementHalfDays,
    active: input.active,
  }).returning();
  return row!;
}

function yearStart(year: number): string {
  return `${year}-01-01`;
}
function yearEnd(year: number): string {
  return `${year}-12-31`;
}
function daysInclusive(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export async function leaveBalance(employeeId: string, leaveTypeId: string, year: number) {
  const employee = await getEmployee(employeeId);
  const [type] = await db.select().from(hrLeaveType).where(eq(hrLeaveType.id, leaveTypeId));
  if (!type) errors.notFound("Leave type");
  const adjustmentRows = await db.select({ halfDaysDelta: hrLeaveAdjustment.halfDaysDelta }).from(hrLeaveAdjustment).where(and(
    eq(hrLeaveAdjustment.employeeId, employeeId),
    eq(hrLeaveAdjustment.leaveTypeId, leaveTypeId),
    eq(hrLeaveAdjustment.leaveYear, year),
  ));
  const approved = await db.select({ halfDays: hrLeaveRequest.halfDays }).from(hrLeaveRequest).where(and(
    eq(hrLeaveRequest.employeeId, employeeId),
    eq(hrLeaveRequest.leaveTypeId, leaveTypeId),
    eq(hrLeaveRequest.status, "approved"),
    gte(hrLeaveRequest.startsOn, yearStart(year)),
    lte(hrLeaveRequest.startsOn, yearEnd(year)),
  ));
  const adjusted = adjustmentRows.reduce((sum, row) => sum + row.halfDaysDelta, 0);
  const usedHalfDays = approved.reduce((sum, row) => sum + row.halfDays, 0);
  return {
    employeeId,
    employeeCode: employee.employeeCode,
    leaveTypeId,
    leaveType: type!.name,
    leaveYear: year,
    paid: type!.paid,
    entitlementHalfDays: type!.annualEntitlementHalfDays,
    adjustmentHalfDays: adjusted,
    usedHalfDays,
    availableHalfDays: type!.annualEntitlementHalfDays + adjusted - usedHalfDays,
  };
}

export async function listLeaveBalances(year: number, employeeId?: string) {
  await ensureDefaultLeaveTypes();
  const employees = employeeId ? [await getEmployee(employeeId)] : await db.select().from(hrEmployee).where(eq(hrEmployee.status, "active")).orderBy(asc(hrEmployee.employeeCode));
  const types = await db.select().from(hrLeaveType).where(eq(hrLeaveType.active, true)).orderBy(asc(hrLeaveType.name));
  const out = [];
  for (const employee of employees) {
    for (const type of types) out.push(await leaveBalance(employee.id, type.id, year));
  }
  return out;
}

export async function listLeaveRequests(input: { employeeId?: string; status?: string; year?: number } = {}) {
  const filters = [];
  if (input.employeeId) filters.push(eq(hrLeaveRequest.employeeId, input.employeeId));
  if (input.status) filters.push(eq(hrLeaveRequest.status, input.status));
  if (input.year) {
    filters.push(gte(hrLeaveRequest.startsOn, yearStart(input.year)), lte(hrLeaveRequest.startsOn, yearEnd(input.year)));
  }
  let query = db.select({
    request: hrLeaveRequest,
    employeeCode: hrEmployee.employeeCode,
    employeeName: hrEmployee.fullName,
    leaveTypeName: hrLeaveType.name,
    paid: hrLeaveType.paid,
  }).from(hrLeaveRequest)
    .innerJoin(hrEmployee, eq(hrEmployee.id, hrLeaveRequest.employeeId))
    .innerJoin(hrLeaveType, eq(hrLeaveType.id, hrLeaveRequest.leaveTypeId))
    .orderBy(desc(hrLeaveRequest.createdAt)).$dynamic();
  if (filters.length) query = query.where(and(...filters));
  return query.limit(1000);
}

export async function createLeaveRequest(input: {
  employeeId: string;
  leaveTypeId: string;
  startsOn: string;
  endsOn: string;
  halfDays: number;
  reason: string;
}, actor: Principal) {
  if (!isValidIsoDate(input.startsOn) || !isValidIsoDate(input.endsOn)) errors.badRequest("Leave dates must be real calendar dates in YYYY-MM-DD format.");
  const employee = await getEmployee(input.employeeId);
  if (employee.status !== "active") errors.conflict("Leave can only be recorded for an active employee.");
  const [type] = await db.select().from(hrLeaveType).where(and(eq(hrLeaveType.id, input.leaveTypeId), eq(hrLeaveType.active, true)));
  if (!type) errors.notFound("Active leave type");
  if (input.startsOn > input.endsOn) errors.badRequest("Leave end date must be on or after the start date.");
  if (input.startsOn.slice(0, 4) !== input.endsOn.slice(0, 4)) errors.badRequest("Split leave requests at the calendar-year boundary so annual balances remain accurate.");
  if (!Number.isSafeInteger(input.halfDays) || input.halfDays < 1 || input.halfDays > daysInclusive(input.startsOn, input.endsOn) * 2) {
    errors.badRequest("Leave duration must be a positive number of half-days no longer than the date range.");
  }
  const overlapping = await db.select({ id: hrLeaveRequest.id }).from(hrLeaveRequest).where(and(
    eq(hrLeaveRequest.employeeId, input.employeeId),
    inArray(hrLeaveRequest.status, ["pending", "approved"]),
    lte(hrLeaveRequest.startsOn, input.endsOn),
    gte(hrLeaveRequest.endsOn, input.startsOn),
  )).limit(1);
  if (overlapping.length) errors.conflict("This employee already has a pending or approved leave request overlapping these dates.");
  if (type!.paid) {
    const balance = await leaveBalance(employee.id, type!.id, Number(input.startsOn.slice(0, 4)));
    if (input.halfDays > balance.availableHalfDays) errors.conflict(`Only ${balance.availableHalfDays / 2} days are available for ${type!.name}.`);
  }
  const [row] = await db.insert(hrLeaveRequest).values({
    id: prefixedId("hlr"),
    employeeId: input.employeeId,
    leaveTypeId: input.leaveTypeId,
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    halfDays: input.halfDays,
    reason: input.reason.trim(),
    status: "pending",
    createdBy: actor.userId,
  }).returning();
  return row!;
}

export async function decideLeaveRequest(input: { requestId: string; decision: "approved" | "rejected"; note: string }, actor: Principal) {
  const [request] = await db.select().from(hrLeaveRequest).where(eq(hrLeaveRequest.id, input.requestId));
  if (!request) errors.notFound("Leave request");
  if (request!.status !== "pending") errors.conflict(`Only pending leave can be decided; this request is ${request!.status}.`);
  const [type] = await db.select().from(hrLeaveType).where(eq(hrLeaveType.id, request!.leaveTypeId));
  if (!type) errors.notFound("Leave type");
  if (input.decision === "approved" && type!.paid) {
    const balance = await leaveBalance(request!.employeeId, request!.leaveTypeId, Number(request!.startsOn.slice(0, 4)));
    if (request!.halfDays > balance.availableHalfDays) errors.conflict("The available paid-leave balance changed. Adjust the balance before approving this request.");
  }
  const [row] = await db.update(hrLeaveRequest).set({
    status: input.decision,
    decidedBy: actor.userId,
    decisionNote: input.note.trim(),
    decidedAt: new Date(),
  }).where(eq(hrLeaveRequest.id, input.requestId)).returning();
  return row!;
}

export async function adjustLeaveBalance(input: {
  employeeId: string;
  leaveTypeId: string;
  leaveYear: number;
  halfDaysDelta: number;
  reason: string;
}, actor: Principal) {
  const employee = await getEmployee(input.employeeId);
  const [type] = await db.select().from(hrLeaveType).where(eq(hrLeaveType.id, input.leaveTypeId));
  if (!type) errors.notFound("Leave type");
  if (!Number.isSafeInteger(input.leaveYear) || input.leaveYear < 2020 || input.leaveYear > 2100) errors.badRequest("Leave year must be a calendar year between 2020 and 2100.");
  if (!Number.isSafeInteger(input.halfDaysDelta) || input.halfDaysDelta === 0) errors.badRequest("The leave adjustment must be a non-zero number of half-days.");
  const current = await leaveBalance(employee.id, type!.id, input.leaveYear);
  if (type!.paid && current.availableHalfDays + input.halfDaysDelta < 0) errors.conflict("This adjustment would make the paid-leave balance negative.");
  const [row] = await db.insert(hrLeaveAdjustment).values({
    id: prefixedId("hla"),
    employeeId: employee.id,
    leaveTypeId: type!.id,
    leaveYear: input.leaveYear,
    halfDaysDelta: input.halfDaysDelta,
    reason: input.reason.trim(),
    createdBy: actor.userId,
  }).returning();
  return row!;
}
