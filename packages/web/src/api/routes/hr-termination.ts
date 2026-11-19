import { z } from "zod";
import { hrProc, mutate } from "../middleware/pipeline";
import * as termination from "../modules/hr/termination";
import { isValidIsoDate } from "../modules/hr/validation";

const isoDay = z.string().refine(isValidIsoDate, "Use a real calendar date in YYYY-MM-DD format.");
const checklist = z.record(z.string(), z.boolean()).default({});
const createFields = z.object({
  employeeId: z.string().min(1),
  terminationType: z.enum(termination.TERMINATION_TYPES),
  noticeGivenOn: isoDay.nullish(),
  lastWorkingOn: isoDay,
  reason: z.string().trim().min(5).max(1000),
  notes: z.string().trim().max(2000).nullish(),
  rehireDecision: z.enum(["eligible", "not_eligible", "eligible_with_approval", "not_assessed"]).default("not_assessed"),
  checklist,
});

export const terminations = hrProc.handler(() => termination.listTerminations());
export const createTermination = hrProc.input(createFields).handler(({ input, context }) => mutate(context, input, { route: "hr.createTermination", entity: "hr_termination", entityId: (row) => (row as { id: string }).id, action: "hr.termination_created" }, () => termination.createTermination(input, context.principal)));
export const submitTermination = hrProc.input(z.object({ id: z.string().min(1) })).handler(({ input, context }) => mutate(context, input, { route: "hr.submitTermination", entity: "hr_termination", entityId: () => input.id, action: "hr.termination_submitted" }, () => termination.submitTermination(input.id, context.principal)));
export const decideTermination = hrProc.input(z.object({ id: z.string().min(1), decision: z.enum(["approved", "rejected"]), decisionNote: z.string().trim().min(3).max(500) })).handler(({ input, context }) => mutate(context, input, { route: "hr.decideTermination", entity: "hr_termination", entityId: () => input.id, action: `hr.termination_${input.decision}` }, () => termination.decideTermination(input, context.principal)));
export const completeTermination = hrProc.input(z.object({ id: z.string().min(1) })).handler(({ input, context }) => mutate(context, input, { route: "hr.completeTermination", entity: "hr_termination", entityId: () => input.id, action: "hr.termination_completed" }, () => termination.completeTermination(input.id, context.principal)));
export const updateTerminationChecklist = hrProc.input(z.object({ id: z.string().min(1), checklist })).handler(({ input, context }) => mutate(context, input, { route: "hr.updateTerminationChecklist", entity: "hr_termination", entityId: () => input.id, action: "hr.termination_checklist_updated" }, () => termination.updateChecklist(input)));

export const hrTermination = { terminations, createTermination, submitTermination, decideTermination, completeTermination, updateTerminationChecklist };
