import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../../database";
import { hrEmployee, hrTimesheet } from "../../database/schema/hr";
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
  return { regularMinutes: Math.min(duration, END_MINUTE - START_MINUTE), overtimeMinutes: Math.max(0, duration - (END_MINUTE - START_MINUTE)) };
}
export async function employeeForPrincipal(principal: Principal) {
  const [employee] = await db.select().from(hrEmployee).where(eq(hrEmployee.identityUserId, principal.userId)).limit(1);
  if (!employee || employee.status !== "active") errors.forbidden("No active HR employee record is linked to this account.");
  return employee!;
}

export async function clockStatus(principal: Principal, workDate = colomboToday()) {
  const employee = await employeeForPrincipal(principal);
  const [row] = await db.select().from(hrTimesheet).where(and(eq(hrTimesheet.employeeId, employee.id), eq(hrTimesheet.workDate, workDate))).limit(1);
  return { workDate, employeeId: employee.id, employeeCode: employee.employeeCode, row: row ?? null, regularStart: "08:30", regularEnd: "17:00", shortLeaveCutoff: "09:30", halfDayCutoff: "12:30" };
}

export async function clockIn(principal: Principal) {
  const employee = await employeeForPrincipal(principal);
  const workDate = colomboToday();
  const now = new Date();
  const [current] = await db.select().from(hrTimesheet).where(and(eq(hrTimesheet.employeeId, employee.id), eq(hrTimesheet.workDate, workDate))).limit(1);
  if (current?.clockInAt && !current.clockOutAt) errors.conflict("You are already clocked in for today.");
  if (current?.clockOutAt) errors.conflict("Today's attendance is already clocked out.");
  const minute = localMinute(now);
  const attendanceStatus = minute <= START_MINUTE ? "present" : minute <= SHORT_LEAVE_CUTOFF ? "short_leave" : minute <= HALF_DAY_CUTOFF ? "half_day" : "absent";
  const values = { clockInAt: now, attendanceStatus, approvalStatus: "pending", source: "rider", regularMinutes: 0, overtimeMinutes: 0, note: minute > START_MINUTE ? `Clocked in at ${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, "0")}` : null, updatedBy: principal.userId, updatedAt: now } as const;
  if (current) {
    const [row] = await db.update(hrTimesheet).set(values).where(eq(hrTimesheet.id, current.id)).returning();
    return row!;
  }
  const [row] = await db.insert(hrTimesheet).values({ id: prefixedId("hts"), employeeId: employee.id, workDate, createdBy: principal.userId, ...values }).returning();
  return row!;
}

export async function clockOut(principal: Principal) {
  const employee = await employeeForPrincipal(principal);
  const workDate = colomboToday();
  const [current] = await db.select().from(hrTimesheet).where(and(eq(hrTimesheet.employeeId, employee.id), eq(hrTimesheet.workDate, workDate))).limit(1);
  if (!current?.clockInAt) errors.conflict("Clock in before clocking out.");
  if (current.clockOutAt) errors.conflict("You are already clocked out for today.");
  const now = new Date();
  const totals = attendanceMinutes(current.clockInAt!, now);
  const [row] = await db.update(hrTimesheet).set({ clockOutAt: now, regularMinutes: totals.regularMinutes, overtimeMinutes: totals.overtimeMinutes, approvalStatus: "pending", updatedBy: principal.userId, updatedAt: now }).where(eq(hrTimesheet.id, current.id)).returning();
  return row!;
}

export async function listAttendance(input: { from: string; to: string; employeeId?: string; approvalStatus?: string; branchId?: string }, principal?: Principal) {
  if (!isValidIsoDate(input.from) || !isValidIsoDate(input.to) || input.from > input.to) errors.badRequest("Attendance dates are invalid.");
  const filters = [gte(hrTimesheet.workDate, input.from), lte(hrTimesheet.workDate, input.to)];
  if (input.employeeId) filters.push(eq(hrTimesheet.employeeId, input.employeeId));
  if (input.approvalStatus) filters.push(eq(hrTimesheet.approvalStatus, input.approvalStatus));
  if (input.branchId) filters.push(eq(hrEmployee.branchId, input.branchId));
  if (principal?.role === "ops" && principal.branchId) filters.push(eq(hrEmployee.branchId, principal.branchId));
  return db.select({ attendance: hrTimesheet, employeeCode: hrEmployee.employeeCode, employeeName: hrEmployee.fullName, branchId: hrEmployee.branchId, department: hrEmployee.department }).from(hrTimesheet).innerJoin(hrEmployee, eq(hrEmployee.id, hrTimesheet.employeeId)).where(and(...filters)).orderBy(desc(hrTimesheet.workDate), asc(hrEmployee.employeeCode)).limit(2000);
}

export async function saveManualAttendance(input: { employeeId: string; workDate: string; clockInAt?: string | null; clockOutAt?: string | null; attendanceStatus: "present" | "absent" | "leave" | "off_duty"; note?: string | null }, actor: Principal) {
  if (!isValidIsoDate(input.workDate)) errors.badRequest("Attendance date is invalid.");
  const [employee] = await db.select().from(hrEmployee).where(and(eq(hrEmployee.id, input.employeeId), eq(hrEmployee.status, "active"))).limit(1);
  if (!employee) errors.notFound("Active employee");
  const clockInAt = input.clockInAt ? new Date(input.clockInAt) : null;
  const clockOutAt = input.clockOutAt ? new Date(input.clockOutAt) : null;
  if (clockInAt && Number.isNaN(clockInAt.getTime())) errors.badRequest("Clock-in time is invalid.");
  if (clockOutAt && Number.isNaN(clockOutAt.getTime())) errors.badRequest("Clock-out time is invalid.");
  if (clockInAt && clockOutAt && clockOutAt <= clockInAt) errors.badRequest("Clock-out must be after clock-in.");
  const totals = clockInAt && clockOutAt ? attendanceMinutes(clockInAt, clockOutAt) : { regularMinutes: 0, overtimeMinutes: 0 };
  const [existing] = await db.select({ id: hrTimesheet.id }).from(hrTimesheet).where(and(eq(hrTimesheet.employeeId, input.employeeId), eq(hrTimesheet.workDate, input.workDate))).limit(1);
  const values = { clockInAt, clockOutAt, regularMinutes: totals.regularMinutes, overtimeMinutes: totals.overtimeMinutes, attendanceStatus: input.attendanceStatus, note: input.note?.trim() || null, source: "hub_manual", approvalStatus: "pending", updatedBy: actor.userId, updatedAt: new Date() } as const;
  if (existing) {
    const [row] = await db.update(hrTimesheet).set(values).where(eq(hrTimesheet.id, existing.id)).returning();
    return row!;
  }
  const [row] = await db.insert(hrTimesheet).values({ id: prefixedId("hts"), employeeId: input.employeeId, workDate: input.workDate, createdBy: actor.userId, ...values }).returning();
  return row!;
}

export async function decideAttendance(input: { ids: string[]; decision: "approved" | "rejected"; note: string }, actor: Principal) {
  if (!input.ids.length) errors.badRequest("Select at least one attendance row.");
  const rows = await db.select({ id: hrTimesheet.id }).from(hrTimesheet).where(inArray(hrTimesheet.id, input.ids));
  if (rows.length !== input.ids.length) errors.notFound("Attendance row");
  await db.update(hrTimesheet).set({ approvalStatus: input.decision, approvalNote: input.note.trim(), approvedBy: actor.userId, approvedAt: new Date(), updatedBy: actor.userId, updatedAt: new Date() }).where(inArray(hrTimesheet.id, input.ids));
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
