import { z } from "zod";
import { hrProc, mutate, opsProc, riderProc } from "../middleware/pipeline";
import * as attendance from "../modules/hr/attendance";
import * as leave from "../modules/hr/leave";
import { isValidIsoDate } from "../modules/hr/validation";

const isoDay = z.string().refine(isValidIsoDate, "Use YYYY-MM-DD.");
const time = z.string().datetime().nullish();
const manualAttendance = z.object({ employeeId: z.string().min(1), workDate: isoDay, clockInAt: time, clockOutAt: time, attendanceStatus: z.enum(["present", "absent", "leave", "off_duty"]), note: z.string().trim().max(500).nullish() });
const leaveInput = z.object({ employeeId: z.string().min(1), leaveTypeId: z.string().min(1), startsOn: isoDay, endsOn: isoDay, halfDays: z.number().int().min(1).max(62), reason: z.string().trim().min(3).max(500) });

export const clockStatus = riderProc.input(z.object({ workDate: isoDay.optional() }).default({})).handler(({ input, context }) => attendance.clockStatus(context.principal, input.workDate));
export const clockIn = riderProc.handler(({ context }) => mutate(context, {}, { route: "hr.clockIn", entity: "hr_timesheet", entityId: () => `${context.principal.userId}:${new Date().toISOString().slice(0, 10)}`, action: "hr.clocked_in" }, () => attendance.clockIn(context.principal)));
export const clockOut = riderProc.handler(({ context }) => mutate(context, {}, { route: "hr.clockOut", entity: "hr_timesheet", entityId: () => `${context.principal.userId}:${new Date().toISOString().slice(0, 10)}`, action: "hr.clocked_out" }, () => attendance.clockOut(context.principal)));
export const riderAttendanceSummary = riderProc.input(z.object({ year: z.number().int().min(2020).max(2100) })).handler(({ input, context }) => attendance.riderSummary(context.principal, input.year));
export const riderLeaveBalances = riderProc.input(z.object({ year: z.number().int().min(2020).max(2100) })).handler(async ({ input, context }) => {
  const employee = await attendance.employeeForPrincipal(context.principal);
  return leave.listLeaveBalances(input.year, employee.id);
});
export const riderApplyLeave = riderProc.input(leaveInput).handler(async ({ input, context }) => {
  const employee = await attendance.employeeForPrincipal(context.principal);
  const scoped = { ...input, employeeId: employee.id };
  return mutate(context, scoped, { route: "hr.riderApplyLeave", entity: "hr_leave_request", entityId: (row) => (row as { id: string }).id, action: "hr.rider_leave_requested" }, () => leave.createLeaveRequest(scoped, context.principal));
});

export const attendanceRows = hrProc.input(z.object({ from: isoDay, to: isoDay, employeeId: z.string().optional(), approvalStatus: z.enum(["pending", "approved", "rejected"]).optional(), branchId: z.string().optional() }).refine((value) => value.from <= value.to, "End date must be on or after start date.")).handler(({ input, context }) => attendance.listAttendance(input, context.principal));
export const saveManualAttendance = opsProc.input(manualAttendance).handler(({ input, context }) => mutate(context, input, { route: "hr.saveManualAttendance", entity: "hr_timesheet", entityId: () => `${input.employeeId}:${input.workDate}`, action: "hr.manual_attendance_saved" }, () => attendance.saveManualAttendance(input, context.principal)));
export const hubApplyLeave = opsProc.input(leaveInput).handler(({ input, context }) => mutate(context, input, { route: "hr.hubApplyLeave", entity: "hr_leave_request", entityId: (row) => (row as { id: string }).id, action: "hr.hub_leave_requested" }, () => leave.createLeaveRequest(input, context.principal)));
export const decideAttendance = hrProc.input(z.object({ ids: z.array(z.string().min(1)).min(1).max(500), decision: z.enum(["approved", "rejected"]), note: z.string().trim().min(2).max(500) })).handler(({ input, context }) => mutate(context, input, { route: "hr.decideAttendance", entity: "hr_timesheet", entityId: () => input.ids.join(","), action: `hr.attendance_${input.decision}` }, () => attendance.decideAttendance(input, context.principal)));

export const hrAttendance = { clockStatus, clockIn, clockOut, riderAttendanceSummary, riderLeaveBalances, riderApplyLeave, attendanceRows, saveManualAttendance, hubApplyLeave, decideAttendance };
