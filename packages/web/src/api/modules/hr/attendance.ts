import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../../database";
import { hrAttendanceSession, hrEmployee, hrLeaveRequest, hrTimesheet } from "../../database/schema/hr";
import { operationsBranchScope } from "../identity/service";
import type { Principal } from "../../shared/auth";
import { colomboToday } from "../../shared/time";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { isValidIsoDate } from "./validation";

const START_MINUTE = 8 * 60 + 30;
const END_MINUTE = 17 * 60;
const SHORT_LEAVE_CUTOFF = 9 * 60 + 30;
const HALF_DAY_CUTOFF = 12 * 60 + 30;

function localMinute(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Colombo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
}
function attendanceMinutes(clockInAt: Date, clockOutAt: Date): { regularMinutes: number; overtimeMinutes: number } {
  const duration = Math.max(0, Math.round((clockOutAt.getTime() - clockInAt.getTime()) / 60000));
  const rawOvertime = Math.max(0, duration - (END_MINUTE - START_MINUTE));
  // Ignore 15 minutes or less; thereafter record completed 15-minute blocks.
  const overtimeMinutes = rawOvertime <= 15 ? 0 : Math.floor(rawOvertime / 15) * 15;
  return { regularMinutes: Math.min(duration, END_MINUTE - START_MINUTE), overtimeMinutes };
}
export async function employeeForPrincipal(principal: Principal) {
  const [employee] = await db.select().from(hrEmployee).where(eq(hrEmployee.identityUserId, principal.userId)).limit(1);
  if (!employee || employee.status !== "active") errors.forbidden("No active HR employee record is linked to this account.");
  return employee!;
}

export async function clockStatus(principal: Principal, workDate = colomboToday()) {
  const employee = await employeeForPrincipal(principal);
  const [row] = await db.select().from(hrTimesheet).where(and(eq(hrTimesheet.employeeId, employee.id), eq(hrTimesheet.workDate, workDate))).limit(1);
  const sessions = await db.select().from(hrAttendanceSession).where(and(eq(hrAttendanceSession.employeeId, employee.id), eq(hrAttendanceSession.workDate, workDate))).orderBy(asc(hrAttendanceSession.clockInAt));
  return { workDate, employeeId: employee.id, employeeCode: employee.employeeCode, row: row ?? null, sessions, openSession: sessions.find((session) => !session.clockOutAt) ?? null, sessionCount: sessions.length, regularMinutes: sessions.reduce((total, session) => total + session.regularMinutes, 0), overtimeMinutes: sessions.reduce((total, session) => total + session.overtimeMinutes, 0), regularStart: "08:30", regularEnd: "17:00", shortLeaveCutoff: "09:30", halfDayCutoff: "12:30" };
}

/** A rider's current field assignment is released only after clock-in. */
export async function isClockedIn(principal: Principal, workDate = colomboToday()) {
  const status = await clockStatus(principal, workDate);
  return Boolean(status.openSession);
}

async function refreshDailyAggregate(employeeId: string, workDate: string, actorId: string) {
  const sessions = await db.select().from(hrAttendanceSession).where(and(eq(hrAttendanceSession.employeeId, employeeId), eq(hrAttendanceSession.workDate, workDate))).orderBy(asc(hrAttendanceSession.clockInAt));
  const first = sessions[0];
  if (!first) return null;
  const last = sessions[sessions.length - 1];
  const totals = sessions.reduce((sum, session) => ({ regularMinutes: sum.regularMinutes + session.regularMinutes, overtimeMinutes: sum.overtimeMinutes + session.overtimeMinutes }), { regularMinutes: 0, overtimeMinutes: 0 });
  const [existing] = await db.select({ id: hrTimesheet.id }).from(hrTimesheet).where(and(eq(hrTimesheet.employeeId, employeeId), eq(hrTimesheet.workDate, workDate))).limit(1);
  const values = { clockInAt: first.clockInAt, clockOutAt: sessions.some((session) => !session.clockOutAt) ? null : last.clockOutAt, regularMinutes: totals.regularMinutes, overtimeMinutes: totals.overtimeMinutes, approvalStatus: "pending", source: "rider", updatedBy: actorId, updatedAt: new Date() } as const;
  if (existing) { const [row] = await db.update(hrTimesheet).set(values).where(eq(hrTimesheet.id, existing.id)).returning(); return row!; }
  const [row] = await db.insert(hrTimesheet).values({ id: prefixedId("hts"), employeeId, workDate, createdBy: actorId, attendanceStatus: "present", overtimeEligible: false, note: null, ...values }).returning();
  return row!;
}

export async function clockIn(principal: Principal) {
  const employee = await employeeForPrincipal(principal);
  const workDate = colomboToday();
  const now = new Date();
  const [open] = await db.select({ id: hrAttendanceSession.id }).from(hrAttendanceSession).where(and(eq(hrAttendanceSession.employeeId, employee.id), eq(hrAttendanceSession.workDate, workDate), isNull(hrAttendanceSession.clockOutAt))).limit(1);
  if (open) errors.conflict("You are already clocked in. Clock out before starting another session.");
  const minute = localMinute(now);
  const attendanceStatus = minute <= START_MINUTE ? "present" : minute <= SHORT_LEAVE_CUTOFF ? "short_leave" : minute <= HALF_DAY_CUTOFF ? "half_day" : "absent";
  await db.insert(hrAttendanceSession).values({ id: prefixedId("has"), employeeId: employee.id, workDate, clockInAt: now, createdBy: principal.userId, updatedBy: principal.userId });
  const [current] = await db.select({ id: hrTimesheet.id }).from(hrTimesheet).where(and(eq(hrTimesheet.employeeId, employee.id), eq(hrTimesheet.workDate, workDate))).limit(1);
  if (current) { const [row] = await db.update(hrTimesheet).set({ attendanceStatus, note: minute > START_MINUTE ? `Clocked in at ${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, "0")}` : null, approvalStatus: "pending", updatedBy: principal.userId, updatedAt: now }).where(eq(hrTimesheet.id, current.id)).returning(); return row!; }
  return refreshDailyAggregate(employee.id, workDate, principal.userId);
}

export async function clockOut(principal: Principal) {
  const employee = await employeeForPrincipal(principal);
  const workDate = colomboToday();
  const [current] = await db.select().from(hrAttendanceSession).where(and(eq(hrAttendanceSession.employeeId, employee.id), eq(hrAttendanceSession.workDate, workDate), isNull(hrAttendanceSession.clockOutAt))).orderBy(desc(hrAttendanceSession.clockInAt)).limit(1);
  if (!current) errors.conflict("Clock in before clocking out.");
  const now = new Date();
  const totals = attendanceMinutes(current!.clockInAt, now);
  await db.update(hrAttendanceSession).set({ clockOutAt: now, regularMinutes: totals.regularMinutes, overtimeMinutes: totals.overtimeMinutes, approvalStatus: "pending", updatedBy: principal.userId, updatedAt: now }).where(eq(hrAttendanceSession.id, current!.id));
  return refreshDailyAggregate(employee.id, workDate, principal.userId);
}

export async function listAttendance(input: { from: string; to: string; employeeId?: string; approvalStatus?: string; branchId?: string }, principal?: Principal) {
  if (!isValidIsoDate(input.from) || !isValidIsoDate(input.to) || input.from > input.to) errors.badRequest("Attendance dates are invalid.");
  const filters = [gte(hrTimesheet.workDate, input.from), lte(hrTimesheet.workDate, input.to)];
  if (input.employeeId) filters.push(eq(hrTimesheet.employeeId, input.employeeId));
  if (input.approvalStatus) filters.push(eq(hrTimesheet.approvalStatus, input.approvalStatus));
  if (input.branchId) filters.push(eq(hrEmployee.branchId, input.branchId));
  if (principal?.role === "ops" && principal.branchId) filters.push(inArray(hrEmployee.branchId, await operationsBranchScope(principal.branchId)));
  return db.select({ attendance: hrTimesheet, employeeCode: hrEmployee.employeeCode, employeeName: hrEmployee.fullName, branchId: hrEmployee.branchId, department: hrEmployee.department }).from(hrTimesheet).innerJoin(hrEmployee, eq(hrEmployee.id, hrTimesheet.employeeId)).where(and(...filters)).orderBy(desc(hrTimesheet.workDate), asc(hrEmployee.employeeCode)).limit(2000);
}

export async function listNonMarkedAttendance(input: { from: string; to: string; employeeId?: string; branchId?: string; department?: string }, principal?: Principal) {
  if (!isValidIsoDate(input.from) || !isValidIsoDate(input.to) || input.from > input.to) errors.badRequest("Attendance dates are invalid.");
  const employeeFilters = [eq(hrEmployee.status, "active")];
  if (input.employeeId) employeeFilters.push(eq(hrEmployee.id, input.employeeId));
  if (input.branchId) employeeFilters.push(eq(hrEmployee.branchId, input.branchId));
  if (input.department) employeeFilters.push(eq(hrEmployee.department, input.department));
  if (principal?.role === "ops" && principal.branchId) employeeFilters.push(inArray(hrEmployee.branchId, await operationsBranchScope(principal.branchId)));
  const employees = await db.select({ id: hrEmployee.id, employeeCode: hrEmployee.employeeCode, employeeName: hrEmployee.fullName, branchId: hrEmployee.branchId, department: hrEmployee.department, joinedOn: hrEmployee.joinedOn }).from(hrEmployee).where(and(...employeeFilters)).orderBy(asc(hrEmployee.employeeCode));
  const marked = await db.select({ employeeId: hrTimesheet.employeeId, workDate: hrTimesheet.workDate }).from(hrTimesheet).where(and(gte(hrTimesheet.workDate, input.from), lte(hrTimesheet.workDate, input.to)));
  const leaves = await db.select({ employeeId: hrLeaveRequest.employeeId, startsOn: hrLeaveRequest.startsOn, endsOn: hrLeaveRequest.endsOn }).from(hrLeaveRequest).where(and(eq(hrLeaveRequest.status, "approved"), lte(hrLeaveRequest.startsOn, input.to), gte(hrLeaveRequest.endsOn, input.from)));
  const markedSet = new Set(marked.map((row) => `${row.employeeId}:${row.workDate}`));
  const leaveSet = new Set<string>();
  for (const leave of leaves) { const start = new Date(`${leave.startsOn}T00:00:00Z`); const end = new Date(`${leave.endsOn}T00:00:00Z`); for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) { const day = d.toISOString().slice(0, 10); if (day >= input.from && day <= input.to) leaveSet.add(`${leave.employeeId}:${day}`); } }
  const out: Array<typeof employees[number] & { workDate: string }> = [];
  for (const employee of employees) for (let d = new Date(`${input.from}T00:00:00Z`); d <= new Date(`${input.to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) { const day = d.toISOString().slice(0, 10); const key = `${employee.id}:${day}`; if (day < employee.joinedOn) continue; if (!markedSet.has(key) && !leaveSet.has(key)) out.push({ ...employee, workDate: day }); }
  return out;
}

export async function saveManualAttendance(input: { employeeId: string; workDate: string; clockInAt?: string | null; clockOutAt?: string | null; attendanceStatus: "present" | "absent" | "leave" | "off_duty"; overtimeEligible?: boolean; note?: string | null }, actor: Principal) {
  if (!isValidIsoDate(input.workDate)) errors.badRequest("Attendance date is invalid.");
  const [employee] = await db.select().from(hrEmployee).where(and(eq(hrEmployee.id, input.employeeId), eq(hrEmployee.status, "active"))).limit(1);
  if (!employee) errors.notFound("Active employee");
  if (actor.roles.includes("ops") && !(await operationsBranchScope(actor.branchId)).includes(employee!.branchId)) {
    errors.forbidden("Hub Managers may only record attendance for staff in their assigned hub and branches.");
  }
  const clockInAt = input.clockInAt ? new Date(input.clockInAt) : null;
  const clockOutAt = input.clockOutAt ? new Date(input.clockOutAt) : null;
  if (clockInAt && Number.isNaN(clockInAt.getTime())) errors.badRequest("Clock-in time is invalid.");
  if (clockOutAt && Number.isNaN(clockOutAt.getTime())) errors.badRequest("Clock-out time is invalid.");
  if (clockInAt && clockOutAt && clockOutAt <= clockInAt) errors.badRequest("Clock-out must be after clock-in.");
  const totals = clockInAt && clockOutAt ? attendanceMinutes(clockInAt, clockOutAt) : { regularMinutes: 0, overtimeMinutes: 0 };
  const [existing] = await db.select({ id: hrTimesheet.id }).from(hrTimesheet).where(and(eq(hrTimesheet.employeeId, input.employeeId), eq(hrTimesheet.workDate, input.workDate))).limit(1);
  const values = { clockInAt, clockOutAt, regularMinutes: totals.regularMinutes, overtimeMinutes: totals.overtimeMinutes, overtimeEligible: Boolean(input.overtimeEligible) && totals.overtimeMinutes > 0, attendanceStatus: input.attendanceStatus, note: input.note?.trim() || null, source: "hub_manual", approvalStatus: "pending", updatedBy: actor.userId, updatedAt: new Date() } as const;
  if (existing) {
    const [row] = await db.update(hrTimesheet).set(values).where(eq(hrTimesheet.id, existing.id)).returning();
    return row!;
  }
  const [row] = await db.insert(hrTimesheet).values({ id: prefixedId("hts"), employeeId: input.employeeId, workDate: input.workDate, createdBy: actor.userId, ...values }).returning();
  return row!;
}

export async function decideAttendance(input: { ids: string[]; decision: "approved" | "rejected"; note: string; overtimeEligibleById?: Record<string, boolean> }, actor: Principal) {
  if (!input.ids.length) errors.badRequest("Select at least one attendance row.");
  const rows = await db.select({ id: hrTimesheet.id }).from(hrTimesheet).where(inArray(hrTimesheet.id, input.ids));
  if (rows.length !== input.ids.length) errors.notFound("Attendance row");
  for (const id of input.ids) {
    await db.update(hrTimesheet).set({ approvalStatus: input.decision, overtimeEligible: input.decision === "approved" ? Boolean(input.overtimeEligibleById?.[id]) : false, approvalNote: input.note.trim(), approvedBy: actor.userId, approvedAt: new Date(), updatedBy: actor.userId, updatedAt: new Date() }).where(eq(hrTimesheet.id, id));
  }
  return { updated: input.ids.length, decision: input.decision };
}

export async function riderSummary(principal: Principal, year: number) {
  const employee = await employeeForPrincipal(principal);
  const from = `${year}-01-01`; const to = `${year}-12-31`;
  const rows = await db.select().from(hrTimesheet).where(and(eq(hrTimesheet.employeeId, employee.id), gte(hrTimesheet.workDate, from), lte(hrTimesheet.workDate, to))).orderBy(desc(hrTimesheet.workDate));
  const shortLeaveDays = rows.filter((row) => row.attendanceStatus === "short_leave").length;
  const halfDays = rows.filter((row) => row.attendanceStatus === "half_day").length;
  const fullLeaveDays = rows.filter((row) => row.attendanceStatus === "leave").length;
  const convertedLeaveDays = Math.floor((shortLeaveDays / 2 + halfDays + fullLeaveDays * 2) / 2);
  return { employeeId: employee.id, year, shortLeaveDays, halfDays, fullLeaveDays, convertedLeaveDays, rows: rows.slice(0, 60), policy: { regularStart: "08:30", regularEnd: "17:00", shortLeaveCutoff: "09:30", halfDayCutoff: "12:30", monthlyShortLeaveLimit: 2, conversion: "2 short leave = 1 half day; 2 half days = 1 day; 2 short + 1 half day = 1 day" } };
}
