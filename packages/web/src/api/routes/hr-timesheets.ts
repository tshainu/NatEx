import { z } from "zod";
import { hrProc, mutate } from "../middleware/pipeline";
import * as hr from "../modules/hr/service";
import { isValidIsoDate } from "../modules/hr/validation";

const isoDay = z.string().refine(isValidIsoDate, "Use a real calendar date in YYYY-MM-DD format.");
const row = z.object({
  employeeCode: z.string().trim().min(2).max(20),
  workDate: isoDay,
  regularMinutes: z.number().int().min(0).max(1440),
  overtimeMinutes: z.number().int().min(0).max(1440),
  attendanceStatus: z.enum(["present", "absent", "leave", "off_duty"]).optional(),
  note: z.string().max(500).nullish(),
  source: z.enum(["manual", "excel"]),
});

export const timesheets = hrProc.input(z.object({
  from: isoDay,
  to: isoDay,
  employeeId: z.string().min(1).optional(),
}).refine((value) => value.from <= value.to, "End date must be on or after start date.")).handler(({ input }) => hr.listTimesheets(input));

export const saveTimesheets = hrProc.input(z.object({ rows: z.array(row).min(1).max(5000) })).handler(({ input, context }) =>
  mutate(context, input, {
    route: "hr.saveTimesheets",
    entity: "hr_timesheet_import",
    entityId: () => `${input.rows[0]!.workDate}:${input.rows.length}`,
    action: "hr.timesheets_saved",
  }, () => hr.saveTimesheets(input.rows, context.principal)),
);

export const hrTimesheets = { timesheets, saveTimesheets };
