import { z } from "zod";
import { opsProc } from "../middleware/pipeline";
import { deliveryAttemptsReport } from "../modules/delivery/service";
import { errors } from "../shared/errors";
import { listBranches, operationsBranchScope } from "../modules/identity/service";

const colomboDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year!, month! - 1, day!);
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month! - 1 &&
      date.getUTCDate() === day
    );
  }, "Enter a valid calendar date.");

/** Read-only paginated delivered/failed attempts; scope is always resolved server-side. */
const attemptsReport = opsProc
  .input(
    z.object({
      fromDate: colomboDate.optional(),
      toDate: colomboDate.optional(),
      branchId: z.string().min(1).optional(),
      outcome: z.enum(["delivered", "failed"]).optional(),
      search: z.string().trim().max(60).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
    }),
  )
  .handler(async ({ input, context }) => {
    const admin = context.principal.role === "admin";
    const authorizedBranchIds = admin
      ? null
      : await operationsBranchScope(context.principal.branchId);
    if (
      input.branchId &&
      authorizedBranchIds !== null &&
      !authorizedBranchIds.includes(input.branchId)
    ) {
      errors.forbidden("You may only report on your assigned branch and its child branches.");
    }

    const [result, allBranches] = await Promise.all([
      deliveryAttemptsReport(input, authorizedBranchIds),
      listBranches({ includeInactive: true }),
    ]);
    const branches = allBranches
      .filter((branch) => authorizedBranchIds === null || authorizedBranchIds.includes(branch.id))
      .map((branch) => ({
        id: branch.id,
        code: branch.code,
        name: branch.name,
        type: branch.type,
      }));
    return { ...result, branches };
  });

export const deliveryReport = { attemptsReport };
