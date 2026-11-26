import { z } from "zod";
import { authedProc, opsProc } from "../middleware/pipeline";
import { requireRole } from "../middleware/auth";
import { db } from "../database";
import { runsheet, runsheetItem } from "../database/schema/delivery";
import { parcel } from "../database/schema/parcels";
import { freightCharge } from "../database/schema/freight";
import { merchant } from "../database/schema/merchants";
import { codEntry, codSettlement, codSettlementLine } from "../database/schema/cod";
import { and, asc, eq, gte, inArray, lte, lt, like, or, sql } from "drizzle-orm";
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
    const counterPaid = sql<number>`coalesce(sum(case when ${parcel.merchantId} is null and ${freightCharge.payer} = 'sender' then ${freightCharge.amountCents} else 0 end), 0)`;
    const delivered = await db.select({ riderId: runsheet.riderId, branchId: runsheet.branchId, deliveredWeightGrams: deliveredWeight, deliveryChargeExpectedCents: deliveredCharge, counterPaidCents: counterPaid })
      .from(runsheet).innerJoin(runsheetItem, eq(runsheetItem.runsheetId, runsheet.id)).innerJoin(parcel, eq(parcel.id, runsheetItem.parcelId)).leftJoin(freightCharge, eq(freightCharge.parcelId, parcel.id))
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
      const counterPaidCents = Number(deliveredRow?.counterPaidCents ?? 0);
      const balanceCents = Math.max(0, expectedCents - collectedCents);
      const unpaidDeliveryChargesCents = Math.max(0, deliveryChargeExpectedCents - freightCollectedCents);
      return { riderId: row.riderId, riderName: row.riderName, branchId: row.branchId, branchName: labelById.get(row.branchId) ?? row.branchId, deliveredWeightGrams, deliveryChargeExpectedCents, counterPaidCents, expectedCents, collectedCents, totalExpectedCollectionCents: expectedCents + deliveryChargeExpectedCents, totalCollectedCollectionCents: collectedCents + freightCollectedCents, balanceCents, deliveryChargeCollectedCents: freightCollectedCents, unpaidDeliveryChargesCents, totalOutstandingCents: balanceCents + unpaidDeliveryChargesCents };
    });
    const totals = rows.reduce((sum, row) => ({
      deliveredWeightGrams: sum.deliveredWeightGrams + row.deliveredWeightGrams,
      deliveryChargeExpectedCents: sum.deliveryChargeExpectedCents + row.deliveryChargeExpectedCents,
      counterPaidCents: sum.counterPaidCents + row.counterPaidCents,
      expectedCents: sum.expectedCents + row.expectedCents,
      collectedCents: sum.collectedCents + row.collectedCents,
      totalExpectedCollectionCents: sum.totalExpectedCollectionCents + row.totalExpectedCollectionCents,
      totalCollectedCollectionCents: sum.totalCollectedCollectionCents + row.totalCollectedCollectionCents,
      balanceCents: sum.balanceCents + row.balanceCents,
      deliveryChargeCollectedCents: sum.deliveryChargeCollectedCents + row.deliveryChargeCollectedCents,
      totalOutstandingCents: sum.totalOutstandingCents + row.totalOutstandingCents,
    }), { deliveredWeightGrams: 0, deliveryChargeExpectedCents: 0, counterPaidCents: 0, expectedCents: 0, collectedCents: 0, totalExpectedCollectionCents: 0, totalCollectedCollectionCents: 0, balanceCents: 0, deliveryChargeCollectedCents: 0, totalOutstandingCents: 0 });
    const pageSize = input.pageSize === 0 ? Math.max(rows.length, 1) : input.pageSize;
    const branches = allBranches.filter((branch) => authorizedBranchIds === null || authorizedBranchIds.includes(branch.id)).map((branch) => ({ id: branch.id, code: branch.code, name: branch.name, type: branch.type, parentHubId: branch.parentHubId }));
    return { rows: rows.slice((input.page - 1) * pageSize, input.page * pageSize), totals, riders: rows.map((row) => ({ id: row.riderId, name: row.riderName, branchId: row.branchId })), branches, page: input.page, pageSize, total: rows.length };
  });

/** Merchant receivables from the immutable COD accrual ledger. */
export const merchantSettlementReport = riderReportProc
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
    const authorizedBranchIds = global ? null : principal.role === "ops" && principal.branchId
      ? await operationsBranchScope(principal.branchId)
      : principal.branchId ? [principal.branchId] : [];
    if (input.branchId && authorizedBranchIds !== null && !authorizedBranchIds.includes(input.branchId)) errors.forbidden("The requested branch is outside your authorized report scope.");
    if (input.riderId && principal.role === "rider" && input.riderId !== principal.userId) errors.forbidden("Riders may only view their own settlement report.");
    const from = new Date(`${input.enteredFrom}T00:00:00+05:30`);
    const toExclusive = new Date(`${input.enteredTo}T00:00:00+05:30`);
    toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
    // The operational receivable is created when the rider collects cash
    // (COLLECT). ACCRUE is a later bank/settlement checkpoint and may not exist
    // yet, so filtering only for ACCRUE makes a valid current-period report
    // appear empty.
    const filters = [eq(codEntry.type, "COLLECT"), gte(codEntry.ts, from), lt(codEntry.ts, toExclusive), sql`${codEntry.merchantId} is not null`];
    if (input.branchId) filters.push(eq(codEntry.branchId, input.branchId));
    else if (authorizedBranchIds !== null && authorizedBranchIds.length) filters.push(inArray(codEntry.branchId, authorizedBranchIds));
    else if (authorizedBranchIds !== null) filters.push(sql`0 = 1`);
    if (principal.role === "rider") filters.push(eq(codEntry.riderId, principal.userId));
    else if (input.riderId) filters.push(eq(codEntry.riderId, input.riderId));
    const search = input.search?.trim();
    if (search) filters.push(or(like(merchant.name, `%${search}%`), like(codEntry.merchantId, `%${search}%`))!);
    const entries = await db.select({ merchantId: codEntry.merchantId, merchantName: merchant.name, branchId: codEntry.branchId, riderId: codEntry.riderId, amountCents: codEntry.amountCents })
      .from(codEntry).innerJoin(merchant, eq(merchant.id, codEntry.merchantId)).where(and(...filters));
    const merchantIds = [...new Set(entries.map((row) => row.merchantId).filter((id): id is string => Boolean(id)))];
    const settlementRows = merchantIds.length ? await db.select().from(codSettlement).where(and(inArray(codSettlement.merchantId, merchantIds), lte(codSettlement.periodStart, input.enteredTo), gte(codSettlement.periodEnd, input.enteredFrom))) : [];
    const settlementIds = settlementRows.map((row) => row.id);
    const settlementLines = settlementIds.length ? await db.select().from(codSettlementLine).where(inArray(codSettlementLine.settlementId, settlementIds)) : [];
    const branchRows = await listBranches({ includeInactive: true });
    const branchNames = new Map(branchRows.map((row) => [row.id, `${row.code} · ${row.name}`]));
    const grouped = new Map<string, { merchantId: string; merchantName: string; branchId: string | null; riderIds: Set<string>; grossCents: number; deductionsCents: number; settledCents: number; status: string }>();
    for (const row of entries) {
      if (!row.merchantId) continue;
      const key = row.merchantId;
      const current = grouped.get(key) ?? { merchantId: key, merchantName: row.merchantName, branchId: row.branchId, riderIds: new Set<string>(), grossCents: 0, deductionsCents: 0, settledCents: 0, status: "open" };
      current.grossCents += Number(row.amountCents ?? 0);
      if (row.riderId) current.riderIds.add(row.riderId);
      grouped.set(key, current);
    }
    for (const row of settlementLines) {
      const current = grouped.get(settlementRows.find((s) => s.id === row.settlementId)?.merchantId ?? "");
      if (!current) continue;
      if (row.type === "cod_collected") current.settledCents += Math.max(0, Number(row.amountCents));
      else if (row.amountCents < 0) current.deductionsCents += Math.abs(Number(row.amountCents));
    }
    for (const row of settlementRows) {
      const current = grouped.get(row.merchantId);
      if (current) current.status = row.status;
    }
    const allRows = [...grouped.values()].map((row) => ({
      merchantId: row.merchantId,
      merchantName: row.merchantName,
      branchId: row.branchId,
      branchName: row.branchId ? (branchNames.get(row.branchId) ?? row.branchId) : "—",
      riderIds: [...row.riderIds],
      grossCents: row.grossCents,
      deductionsCents: row.deductionsCents,
      alreadySettledCents: row.settledCents,
      netReceivableCents: Math.max(0, row.grossCents - row.deductionsCents - row.settledCents),
      status: row.status,
    })).sort((a, b) => a.merchantName.localeCompare(b.merchantName));
    const totals = allRows.reduce((sum, row) => ({ grossCents: sum.grossCents + row.grossCents, deductionsCents: sum.deductionsCents + row.deductionsCents, alreadySettledCents: sum.alreadySettledCents + row.alreadySettledCents, netReceivableCents: sum.netReceivableCents + row.netReceivableCents }), { grossCents: 0, deductionsCents: 0, alreadySettledCents: 0, netReceivableCents: 0 });
    const pageSize = input.pageSize === 0 ? Math.max(allRows.length, 1) : input.pageSize;
    const riders = [...new Map(entries.filter((row) => row.riderId).map((row) => [row.riderId!, { id: row.riderId!, name: row.riderId!, branchId: row.branchId }])).values()];
    const branches = branchRows.filter((row) => authorizedBranchIds === null || authorizedBranchIds.includes(row.id)).map((row) => ({ id: row.id, code: row.code, name: row.name, type: row.type, parentHubId: row.parentHubId }));
    return { rows: allRows.slice((input.page - 1) * pageSize, input.page * pageSize), totals, branches, riders, page: input.page, pageSize, total: allRows.length };
  });

export const codReport = { reconciliationReport, riderReport, merchantSettlementReport };
