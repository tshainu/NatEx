import { z } from "zod";
import { opsProc } from "../middleware/pipeline";
import * as transportService from "../modules/transport/service";

const colomboDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(0);
    parsed.setUTCHours(0, 0, 0, 0);
    parsed.setUTCFullYear(year!, month! - 1, day!);
    return parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month! - 1 &&
      parsed.getUTCDate() === day;
  }, "Enter a valid Asia/Colombo calendar date.");

/** Read-only, server-paginated Hub & Bag Movement report for Ops and Admin. */
const movementReport = opsProc
  .input(
    z.object({
      from: colomboDateSchema,
      to: colomboDateSchema,
      branchId: z.string().min(1).optional(),
      hubId: z.string().min(1).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
    }),
  )
  .handler(({ input, context }) =>
    transportService.movementReport(input, context.principal),
  );

export const transportReport = { movementReport };
