import { z } from "zod";
import { opsProc } from "../middleware/pipeline";
import * as codService from "../modules/cod/service";
import * as parcelsService from "../modules/parcels/service";
import { errors } from "../shared/errors";
import { listBranches, operationsBranchScope } from "../modules/identity/service";

const colomboDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year!, month! - 1, day!);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
  }, "Enter a valid calendar date.");

export const reconciliationReport = opsProc
  .input(
    z.object({
      enteredFrom: colomboDateSchema,
      enteredTo: colomboDateSchema,
      branchId: z.string().min(1).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
    }),
  )
  .handler(async ({ input, context }) => {
    const isAdmin = context.principal.role === "admin";
    const branchId = context.principal.branchId;
    if (!isAdmin && !branchId) errors.forbidden("This operations account is not assigned to a branch.");
    const authorizedBranchIds = isAdmin ? null : await operationsBranchScope(branchId!);
    if (
      input.branchId &&
      authorizedBranchIds !== null &&
      !authorizedBranchIds.includes(input.branchId)
    ) {
      errors.forbidden("The requested branch is outside your authorized report scope.");
    }

    const [expected, allBranches] = await Promise.all([
      parcelsService.expectedCodParcelsForReport(
        input,
        authorizedBranchIds,
      ),
      listBranches({ includeInactive: true }),
    ]);
    const collections = await codService.collectionFactsForReport(expected.rows.map((row) => row.id));
    const collectedByParcel = new Map(collections.map((row) => [row.parcelId, row]));
    const labelById = new Map(
      allBranches.map((branch) => [branch.id, `${branch.code} · ${branch.name}`]),
    );
    const branches = allBranches
      .filter((branch) => authorizedBranchIds === null || authorizedBranchIds.includes(branch.id))
      .map((branch) => ({
        id: branch.id,
        code: branch.code,
        name: branch.name,
        type: branch.type,
        parentHubId: branch.parentHubId,
      }));

    return {
      ...expected,
      branches,
      rows: expected.rows.map((row) => {
        const collection = collectedByParcel.get(row.id);
        const collectedCents = collection?.collectedCents ?? 0;
        const varianceCents = collectedCents - row.expectedCents;
        return {
          ...row,
          branchName: labelById.get(row.branchId) ?? row.branchId,
          collectedCents,
          collectedAt: collection?.collectedAt ?? null,
          varianceCents,
          reconciliationStatus: !collection
            ? "Not collected"
            : varianceCents === 0
              ? "Matched"
              : "Mismatch",
        };
      }),
    };
  });

export const codReport = { reconciliationReport };
