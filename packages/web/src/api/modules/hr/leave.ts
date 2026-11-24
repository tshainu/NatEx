import { and, asc, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { db } from "../../database";
import { hrEmployee, hrLeaveAdjustment, hrLeaveRequest, hrLeaveType } from "../../database/schema/hr";
import type { Principal } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { getEmployee } from "./service";
import { listBranches } from "../identity/service";
import { isValidIsoDate } from "./validation";

export type LeaveTypeRow = typeof hrLeaveType.$inferSelect;
export type LeaveRequestRow = typeof hrLeaveRequest.$inferSelect;

const DEFAULT_LEAVE_TYPES = [
  { code: "ANNUAL", name: "Annual leave", paid: true },
  { code: "CASUAL", name: "Casual leave", paid: true },
  { code: "SICK", name: "Medical leave", paid: true },
  { code: "UNPAID", name: "Unpaid leave", paid: false },
  { code: "SHORT", name: "Short leave", paid: true },
  { code: "HALF_DAY", name: "Half-day leave", paid: true },
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

export async function listLeaveBalances(year: number, employeeId?: string, branchId?: string, hubId?: string) {
  await ensureDefaultLeaveTypes();
  const allowedBranchIds = branchId || hubId
    ? (await listBranches({ includeInactive: true })).filter((branch) =>
      branchId ? branch.id === branchId : branch.id === hubId || branch.parentHubId === hubId,
    ).map((branch) => branch.id)
    : null;
  const employeeFilters = [eq(hrEmployee.status, "active")];
  if (allowedBranchIds) employeeFilters.push(inArray(hrEmployee.branchId, allowedBranchIds));
  if (employeeId) employeeFilters.push(eq(hrEmployee.id, employeeId));
  const employees = employeeId ? [await getEmployee(employeeId)] : await db.select().from(hrEmployee).where(and(...employeeFilters)).orderBy(asc(hrEmployee.employeeCode));
  const types = await db.select().from(hrLeaveType).where(eq(hrLeaveType.active, true)).orderBy(asc(hrLeaveType.name));
  const out = [];
  for (const employee of employees) {
    for (const type of types) out.push(await leaveBalance(employee.id, type.id, year));
  }
  return out;
}

export async function listLeaveRequests(input: { employeeId?: string; status?: string; year?: number; branchId?: string; hubId?: string } = {}) {
  const filters = [];
  if (input.employeeId) filters.push(eq(hrLeaveRequest.employeeId, input.employeeId));
  if (input.status) filters.push(eq(hrLeaveRequest.status, input.status));
  if (input.year) {
    filters.push(gte(hrLeaveRequest.startsOn, yearStart(input.year)), lte(hrLeaveRequest.startsOn, yearEnd(input.year)));
  }
  if (input.branchId || input.hubId) {
    const allowedBranchIds = (await listBranches({ includeInactive: true })).filter((branch) =>
      input.branchId ? branch.id === input.branchId : branch.id === input.hubId || branch.parentHubId === input.hubId,
    ).map((branch) => branch.id);
    filters.push(inArray(hrEmployee.branchId, allowedBranchIds));
  }
  let query = db.select({
    request: hrLeaveRequest,
    employeeCode: hrEmployee.employeeCode,
    employeeName: hrEmployee.fullName,
    branchId: hrEmployee.branchId,
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
  if (actor.roles.includes("ops") && employee.branchId !== actor.branchId) {
    errors.forbidden("Hub Managers may only request leave for staff in their assigned hub.");
  }
  const [type] = await db.select().from(hrLeaveType).where(and(eq(hrLeaveType.id, input.leaveTypeId), eq(hrLeaveType.active, true)));
  if (!type) errors.notFound("Active leave type");
  if (input.startsOn > input.endsOn) errors.badRequest("Leave end date must be on or after the start date.");
  if (input.startsOn.slice(0, 4) !== input.endsOn.slice(0, 4)) errors.badRequest("Split leave requests at the calendar-year boundary so annual balances remain accurate.");
  if (type!.code === "HALF_DAY" && input.halfDays !== 1) errors.badRequest("A half-day leave request must be one half-day unit.");
  if (type!.code === "SHORT") {
    if (input.halfDays !== 1 || input.startsOn !== input.endsOn) errors.badRequest("A short leave request must cover one half-day unit on one date.");
    const monthStart = `${input.startsOn.slice(0, 7)}-01`;
    const monthEnd = `${input.startsOn.slice(0, 7)}-31`;
    const shortTypeRequests = await db.select({ halfDays: hrLeaveRequest.halfDays }).from(hrLeaveRequest).where(and(
      eq(hrLeaveRequest.employeeId, input.employeeId), eq(hrLeaveRequest.leaveTypeId, type!.id),
      inArray(hrLeaveRequest.status, ["pending", "approved"]), gte(hrLeaveRequest.startsOn, monthStart), lte(hrLeaveRequest.startsOn, monthEnd),
    ));
    if (shortTypeRequests.reduce((sum, row) => sum + row.halfDays, 0) >= 2) errors.conflict("Only two short-leave units are permitted per employee each month.");
  }
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
  if (type!.paid && type!.code !== "SHORT" && type!.code !== "HALF_DAY") {
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

export async function cancelLeaveRequest(requestId: string, actor: Principal, note = "Cancelled before HR approval") {
  const [request] = await db.select().from(hrLeaveRequest).where(eq(hrLeaveRequest.id, requestId));
  if (!request) errors.notFound("Leave request");
  if (request!.status !== "pending") errors.conflict(`Only pending leave can be cancelled; this request is ${request!.status}.`);
  const [employee] = await db.select({ identityUserId: hrEmployee.identityUserId, branchId: hrEmployee.branchId }).from(hrEmployee).where(eq(hrEmployee.id, request!.employeeId));
  const isHr = actor.roles.some((role) => role === "hr" || role === "admin" || role === "gom");
  const isApplicant = request!.createdBy === actor.userId || employee?.identityUserId === actor.userId;
  if (!isHr && !isApplicant) errors.forbidden("Only HR or the employee who applied may cancel pending leave.");
  if (actor.role === "ops" && employee?.branchId !== actor.branchId) errors.forbidden("Hub Managers may only cancel leave in their assigned hub.");
  const [row] = await db.update(hrLeaveRequest).set({ status: "cancelled", decidedBy: actor.userId, decisionNote: note.trim(), decidedAt: new Date() }).where(and(eq(hrLeaveRequest.id, requestId), eq(hrLeaveRequest.status, "pending"))).returning();
  if (!row) errors.conflict("This leave request was already changed. Refresh and try again.");
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
