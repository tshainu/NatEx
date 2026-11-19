import { z } from "zod";
import { financeProc, hrProc, mutate, payrollReadProc } from "../middleware/pipeline";
import * as holiday from "../modules/hr/holiday";
import * as payout from "../modules/hr/leave-payout";
import { isValidIsoDate } from "../modules/hr/validation";

const isoDay = z.string().refine(isValidIsoDate, "Use a real calendar date in YYYY-MM-DD format.");
const year = z.number().int().min(2020).max(2100);

export const holidays = hrProc.input(z.object({ year: year.optional(), active: z.boolean().optional() })).handler(({ input }) => holiday.listHolidays(input));
export const saveHoliday = hrProc.input(z.object({
  id: z.string().min(1).optional(),
  holidayDate: isoDay,
  name: z.string().trim().min(2).max(160),
  scope: z.enum(["company", "hub", "branch"]),
  scopeId: z.string().min(1).optional(),
  otAllowed: z.boolean(),
  compulsoryLeave: z.boolean(),
  active: z.boolean(),
})).handler(({ input, context }) => mutate(context, input, {
  route: "hr.saveHoliday", entity: "hr_holiday", entityId: (row) => (row as { id: string }).id, action: "hr.holiday_saved",
}, () => holiday.saveHoliday(input, context.principal)));

export const leavePayoutRuns = payrollReadProc.handler(() => payout.listPayoutRuns());
export const leavePayoutRun = payrollReadProc.input(z.object({ runId: z.string().min(1) })).handler(({ input }) => payout.getPayoutRun(input.runId));
export const generateLeavePayout = hrProc.input(z.object({ year })).handler(({ input, context }) => mutate(context, input, {
  route: "hr.generateLeavePayout", entity: "hr_leave_payout_run", entityId: (row) => (row as { run: { id: string } }).run.id, action: "hr.leave_payout_generated",
}, () => payout.generatePayout(input.year, context.principal)));
export const submitLeavePayout = hrProc.input(z.object({ runId: z.string().min(1) })).handler(({ input, context }) => mutate(context, input, {
  route: "hr.submitLeavePayout", entity: "hr_leave_payout_run", entityId: () => input.runId, action: "hr.leave_payout_submitted",
}, () => payout.submitPayout(input.runId, context.principal)));
export const approveLeavePayout = hrProc.input(z.object({ runId: z.string().min(1), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(500).optional() })).handler(({ input, context }) => mutate(context, input, {
  route: "hr.approveLeavePayout", entity: "hr_leave_payout_run", entityId: () => input.runId, action: `hr.leave_payout_${input.decision}`,
}, () => payout.decidePayout(input, context.principal)));
export const recordLeavePayoutPayment = financeProc.input(z.object({ runId: z.string().min(1), reference: z.string().trim().min(3).max(200) })).handler(({ input, context }) => mutate(context, input, {
  route: "hr.recordLeavePayoutPayment", entity: "hr_leave_payout_run", entityId: () => input.runId, action: "hr.leave_payout_paid",
}, () => payout.recordPayoutPayment(input, context.principal)));

export const hrCalendar = { holidays, saveHoliday, leavePayoutRuns, leavePayoutRun, generateLeavePayout, submitLeavePayout, approveLeavePayout, recordLeavePayoutPayment };
