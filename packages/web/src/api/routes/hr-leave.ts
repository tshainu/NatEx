import { z } from "zod";
import { hrProc, mutate } from "../middleware/pipeline";
import * as leave from "../modules/hr/leave";
import { isValidIsoDate } from "../modules/hr/validation";

const isoDay = z.string().refine(isValidIsoDate, "Use a real calendar date in YYYY-MM-DD format.");
const year = z.number().int().min(2020).max(2100);

export const leaveTypes = hrProc.handler(() => leave.listLeaveTypes());
export const saveLeaveType = hrProc.input(z.object({
  id: z.string().min(1).optional(),
  code: z.string().trim().min(2).max(20),
  name: z.string().trim().min(2).max(120),
  paid: z.boolean(),
  annualEntitlementHalfDays: z.number().int().min(0).max(1000),
  active: z.boolean(),
})).handler(({ input, context }) => mutate(context, input, {
  route: "hr.saveLeaveType",
  entity: "hr_leave_type",
  entityId: () => input.id ?? input.code,
  action: "hr.leave_type_saved",
}, () => leave.saveLeaveType(input)));

export const leaveBalances = hrProc.input(z.object({ year: year.default(new Date().getFullYear()), employeeId: z.string().min(1).optional() })).handler(({ input }) => leave.listLeaveBalances(input.year, input.employeeId));
export const leaveRequests = hrProc.input(z.object({
  employeeId: z.string().min(1).optional(),
  status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
  year: year.optional(),
})).handler(({ input }) => leave.listLeaveRequests(input));

export const createLeaveRequest = hrProc.input(z.object({
  employeeId: z.string().min(1),
  leaveTypeId: z.string().min(1),
  startsOn: isoDay,
  endsOn: isoDay,
  halfDays: z.number().int().min(1).max(730),
  reason: z.string().trim().min(3).max(500),
})).handler(({ input, context }) => mutate(context, input, {
  route: "hr.createLeaveRequest",
  entity: "hr_leave_request",
  entityId: (row) => (row as { id: string }).id,
  action: "hr.leave_requested",
}, () => leave.createLeaveRequest(input, context.principal)));

export const decideLeaveRequest = hrProc.input(z.object({
  requestId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().min(3).max(500),
})).handler(({ input, context }) => mutate(context, input, {
  route: "hr.decideLeaveRequest",
  entity: "hr_leave_request",
  entityId: () => input.requestId,
  action: `hr.leave_${input.decision}`,
}, () => leave.decideLeaveRequest(input, context.principal)));

export const adjustLeaveBalance = hrProc.input(z.object({
  employeeId: z.string().min(1),
  leaveTypeId: z.string().min(1),
  leaveYear: year,
  halfDaysDelta: z.number().int().min(-1000).max(1000).refine((value) => value !== 0),
  reason: z.string().trim().min(5).max(500),
})).handler(({ input, context }) => mutate(context, input, {
  route: "hr.adjustLeaveBalance",
  entity: "hr_leave_adjustment",
  entityId: (row) => (row as { id: string }).id,
  action: "hr.leave_balance_adjusted",
}, () => leave.adjustLeaveBalance(input, context.principal)));

export const hrLeave = { leaveTypes, saveLeaveType, leaveBalances, leaveRequests, createLeaveRequest, decideLeaveRequest, adjustLeaveBalance };
