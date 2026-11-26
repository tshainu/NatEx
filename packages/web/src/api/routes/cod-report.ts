import { z } from "zod";
import { authedProc, opsProc } from "../middleware/pipeline";
import { requireRole } from "../middleware/auth";
import { db } from "../database";
import { runsheet, runsheetItem } from "../database/schema/delivery";
import { parcel } from "../database/schema/parcels";
import { and, asc, eq, gte, inArray, lte, like, or, sql } from "drizzle-orm";
import * as codService from "../modules/cod/service";
import * as parcelsService from "../modules/parcels/service";
import { errors } from "../shared/errors";
import { isGlobalScope } from "../shared/auth";
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
    const isAdmin = isGlobalScope(context.principal.role);
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

const riderReportProc = authedProc.use(requireRole("ops", "admin", "gom", "super_admin", "nos_admin", "hr", "finance", "rider"));

export const riderReport = riderReportProc
  .input(z.object({
    enteredFrom: colomboDateSchema,
    enteredTo: colomboDateSchema,
    branchId: z.string().min(1).optional(),
    riderId: z.string().min(1).optional(),
    search: z.string().max(120).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.union([z.literal(0), z.literal(25), z.literal(50), z.literal(100), z.literal(500)]).default(25),
  }))
  .handler(async ({ input, context }) => {
    if (input.enteredFrom > input.enteredTo) errors.badRequest("Report start date must be on or before the end date.");
    const principal = context.principal;
    const global = isGlobalScope(principal.role);
    const authorizedBranchIds = global
      ? null
      : principal.role === "ops" && principal.branchId
        ? await operationsBranchScope(principal.branchId)
        : [principal.branchId];
    if (input.branchId && authorizedBranchIds !== null && !authorizedBranchIds.includes(input.branchId)) errors.forbidden("The requested branch is outside your authorized report scope.");
    if (input.riderId && principal.role === "rider" && input.riderId !== principal.userId) errors.forbidden("Riders may only view their own rider report.");

    const filters = [gte(runsheet.runDate, input.enteredFrom), lte(runsheet.runDate, input.enteredTo), sql`${runsheet.status} <> 'cancelled'`];
    if (input.branchId) filters.push(eq(runsheet.branchId, input.branchId));
    else if (authorizedBranchIds !== null) filters.push(inArray(runsheet.branchId, authorizedBranchIds));
    if (principal.role === "rider") filters.push(eq(runsheet.riderId, principal.userId));
    else if (input.riderId) filters.push(eq(runsheet.riderId, input.riderId));
    const search = input.search?.trim();
    if (search) filters.push(or(like(runsheet.riderName, `%${search}%`), like(runsheet.riderId, `%${search}%`))!);

    const expected = sql<number>`coalesce(sum(${runsheet.codExpectedCents}), 0)`;
    const collected = sql<number>`coalesce(sum(${runsheet.codCollectedCents}), 0)`;
    const freightCollected = sql<number>`coalesce(sum(${runsheet.freightCollectedCents}), 0)`;
    const grouped = await db.select({
      riderId: runsheet.riderId,
      riderName: runsheet.riderName,
      branchId: runsheet.branchId,
      expectedCents: expected,
      collectedCents: collected,
      freightCollectedCents: freightCollected,
    }).from(runsheet).where(and(...filters)).groupBy(runsheet.riderId, runsheet.riderName, runsheet.branchId).orderBy(asc(runsheet.riderName), asc(runsheet.riderId));
    const deliveredWeight = sql<number>`coalesce(sum(${parcel.weightGrams}), 0)`;
    const deliveredCharge = sql<number>`coalesce(sum(${runsheetItem.freightAmountCents}), 0)`;
    const delivered = await db.select({ riderId: runsheet.riderId, branchId: runsheet.branchId, deliveredWeightGrams: deliveredWeight, deliveryChargeExpectedCents: deliveredCharge })
      .from(runsheet).innerJoin(runsheetItem, eq(runsheetItem.runsheetId, runsheet.id)).innerJoin(parcel, eq(parcel.id, runsheetItem.parcelId))
      .where(and(...filters, eq(runsheetItem.state, "delivered"))).groupBy(runsheet.riderId, runsheet.branchId);
    const deliveredByKey = new Map(delivered.map((row) => [`${row.riderId}:${row.branchId}`, row]));

    const allBranches = await listBranches({ includeInactive: true });
    const labelById = new Map(allBranches.map((branch) => [branch.id, `${branch.code} · ${branch.name}`]));
    const rows = grouped.map((row) => {
      const expectedCents = Number(row.expectedCents ?? 0);
      const collectedCents = Number(row.collectedCents ?? 0);
      const freightCollectedCents = Number(row.freightCollectedCents ?? 0);
      const deliveredRow = deliveredByKey.get(`${row.riderId}:${row.branchId}`);
      const deliveredWeightGrams = Number(deliveredRow?.deliveredWeightGrams ?? 0);
      const deliveryChargeExpectedCents = Number(deliveredRow?.deliveryChargeExpectedCents ?? 0);
      const balanceCents = Math.max(0, expectedCents - collectedCents);
      const unpaidDeliveryChargesCents = Math.max(0, deliveryChargeExpectedCents - freightCollectedCents);
      return { riderId: row.riderId, riderName: row.riderName, branchId: row.branchId, branchName: labelById.get(row.branchId) ?? row.branchId, deliveredWeightGrams, deliveryChargeExpectedCents, expectedCents, collectedCents, balanceCents, deliveryChargeCollectedCents: freightCollectedCents, unpaidDeliveryChargesCents, totalOutstandingCents: balanceCents + unpaidDeliveryChargesCents };
    });
    const totals = rows.reduce((sum, row) => ({
      deliveredWeightGrams: sum.deliveredWeightGrams + row.deliveredWeightGrams,
      deliveryChargeExpectedCents: sum.deliveryChargeExpectedCents + row.deliveryChargeExpectedCents,
      expectedCents: sum.expectedCents + row.expectedCents,
      collectedCents: sum.collectedCents + row.collectedCents,
      balanceCents: sum.balanceCents + row.balanceCents,
      deliveryChargeCollectedCents: sum.deliveryChargeCollectedCents + row.deliveryChargeCollectedCents,
      totalOutstandingCents: sum.totalOutstandingCents + row.totalOutstandingCents,
    }), { deliveredWeightGrams: 0, deliveryChargeExpectedCents: 0, expectedCents: 0, collectedCents: 0, balanceCents: 0, deliveryChargeCollectedCents: 0, totalOutstandingCents: 0 });
    const pageSize = input.pageSize === 0 ? Math.max(rows.length, 1) : input.pageSize;
    const branches = allBranches.filter((branch) => authorizedBranchIds === null || authorizedBranchIds.includes(branch.id)).map((branch) => ({ id: branch.id, code: branch.code, name: branch.name, type: branch.type, parentHubId: branch.parentHubId }));
    return { rows: rows.slice((input.page - 1) * pageSize, input.page * pageSize), totals, riders: rows.map((row) => ({ id: row.riderId, name: row.riderName, branchId: row.branchId })), branches, page: input.page, pageSize, total: rows.length };
  });

export const codReport = { reconciliationReport, riderReport };
