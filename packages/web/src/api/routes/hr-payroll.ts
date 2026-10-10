import { z } from "zod";
import { financeProc, hrProc, mutate, payrollReadProc } from "../middleware/pipeline";
import * as payroll from "../modules/hr/payroll";
import { isValidIsoDate } from "../modules/hr/validation";

const isoDay = z.string().refine(isValidIsoDate, "Use a real calendar date in YYYY-MM-DD format.");

export const apitSchedule = payrollReadProc.handler(() => payroll.getApitSchedule());
export const saveApitSchedule = financeProc.input(z.object({
  bands: z.array(z.object({
    maxMonthlyCents: z.number().int().nonnegative().max(10_000_000_000).nullable(),
    rateBps: z.number().int().min(0).max(10_000),
    offsetCents: z.number().int().nonnegative().max(10_000_000_000),
  })).min(1).max(20),
})).handler(({ input, context }) => mutate(context, input, {
  route: "hr.saveApitSchedule",
  entity: "hr_apit_schedule",
  entityId: (row) => (row as { id: string }).id,
  action: "hr.apit_schedule_updated",
}, () => payroll.saveApitSchedule(input)));
export const validateApitSchedule = financeProc.input(z.object({
  accountantName: z.string().trim().min(3).max(160),
  reference: z.string().trim().min(5).max(300),
})).handler(({ input, context }) => mutate(context, input, {
  route: "hr.validateApitSchedule",
  entity: "hr_apit_schedule",
  entityId: () => "lk-apit-2026-27-provisional-v1",
  action: "hr.apit_schedule_validated",
}, () => payroll.validateApitSchedule(input, context.principal)));

export const payrollRuns = payrollReadProc.handler(({ context }) => payroll.listPayrollRuns(context.principal));
export const payrollRun = payrollReadProc.input(z.object({ runId: z.string().min(1) })).handler(({ input, context }) => payroll.getPayrollRun(input.runId, context.principal));
export const createPayrollRun = hrProc.input(z.object({ periodStart: isoDay, periodEnd: isoDay })).handler(({ input, context }) => mutate(context, input, {
  route: "hr.createPayrollRun",
  entity: "hr_payroll_run",
  entityId: (row) => (row as { run: { id: string } }).run.id,
  action: "hr.payroll_drafted",
}, () => payroll.createPayrollRun(input, context.principal)));
export const manualApit = hrProc.input(z.object({
  runId: z.string().min(1),
  employeeId: z.string().min(1),
  amountCents: z.number().int().min(0).max(10_000_000_000),
  reason: z.string().trim().min(5).max(300),
})).handler(({ input, context }) => mutate(context, input, {
  route: "hr.manualApit",
  entity: "hr_payroll_line",
  entityId: () => `${input.runId}:${input.employeeId}`,
  action: "hr.apit_manual_override",
}, () => payroll.setManualApit(input, context.principal)));
export const submitPayrollRun = hrProc.input(z.object({ runId: z.string().min(1) })).handler(({ input, context }) => mutate(context, input, {
  route: "hr.submitPayrollRun",
  entity: "hr_payroll_run",
  entityId: () => input.runId,
  action: "hr.payroll_submitted",
}, () => payroll.submitPayrollRun(input.runId, context.principal)));
export const approvePayrollRun = financeProc.input(z.object({ runId: z.string().min(1) })).handler(({ input, context }) => mutate(context, input, {
  route: "hr.approvePayrollRun",
  entity: "hr_payroll_run",
  entityId: () => input.runId,
  action: "hr.payroll_approved",
}, () => payroll.approvePayrollRun(input.runId, context.principal)));
export const recordPayrollPayment = financeProc.input(z.object({ runId: z.string().min(1), reference: z.string().trim().min(3).max(200) })).handler(({ input, context }) => mutate(context, input, {
  route: "hr.recordPayrollPayment",
  entity: "hr_payroll_run",
  entityId: () => input.runId,
  action: "hr.payroll_paid",
}, () => payroll.recordPayrollPayment(input, context.principal)));
export const cancelDraftPayrollRun = hrProc.input(z.object({ runId: z.string().min(1), reason: z.string().trim().min(5).max(500) })).handler(({ input, context }) => mutate(context, input, {
  route: "hr.cancelDraftPayrollRun",
  entity: "hr_payroll_run",
  entityId: () => input.runId,
  action: "hr.payroll_draft_cancelled",
}, () => payroll.cancelDraftPayrollRun(input, context.principal)));
export const statutoryReport = payrollReadProc.input(z.object({ runId: z.string().min(1) })).handler(({ input, context }) => payroll.statutoryReport(input.runId, context.principal));

export const hrPayroll = { apitSchedule, saveApitSchedule, validateApitSchedule, payrollRuns, payrollRun, createPayrollRun, manualApit, submitPayrollRun, approvePayrollRun, recordPayrollPayment, cancelDraftPayrollRun, statutoryReport };
