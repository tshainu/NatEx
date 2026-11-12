import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../database";
import { awbBatch, awbBatchLabel, awbBatchSeries, parcel, retiredTrackingNumber } from "../../database/schema/parcels";
import { getMerchant } from "../merchants/service";
import { getBranch } from "../identity/service";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import type { Principal } from "../../shared/auth";
import type { DbTransaction } from "../../database/transaction";
import { AWB_LABELS_PER_BATCH, MAX_LABELS_PER_GENERATION, MAX_NUMBERS_PER_BATCH, createAwbSeries, planAwbBatchRanges, randomAwbSeriesStart } from "./awb-series";

const LABEL_INSERT_CHUNK = 200;
export const MAX_BATCHES_PER_GENERATION = 50;

export type AwbBatchRow = typeof awbBatch.$inferSelect;
export type AwbBatchWithSeries = AwbBatchRow & { seriesNumber: number };
export type AwbAssigneeType = "merchant" | "branch" | "hub";
export type AwbAssignmentStatus = "planned" | "assigned";
export type AwbBatchState = AwbAssignmentStatus | "depleted";

class AwbRangeOccupied extends Error {}

function errorChainText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  return `${error.message} ${cause === undefined ? "" : errorChainText(cause)}`;
}

function isReservationConflict(error: unknown): boolean {
  const message = errorChainText(error);
  return message.includes("UNIQUE constraint failed: parcels_awb_batch_label.awb") ||
    message.includes("parcels_awb_batch.batch_code") ||
    message.includes("parcels_awb_batch.id");
}

function assignmentFor(row: Pick<AwbBatchRow, "assignmentStatus" | "assigneeType" | "assigneeId" | "assigneeName" | "merchantId" | "merchantName">) {
  // Rows written before assignment tracking are still assigned merchant batches.
  const assigneeType = (row.assigneeType as AwbAssigneeType | null) ?? (row.merchantId ? "merchant" : null);
  const assigneeId = row.assigneeId ?? (assigneeType === "merchant" ? row.merchantId : null);
  const assigneeName = row.assigneeName ?? (assigneeType === "merchant" ? row.merchantName : null);
  const assignmentStatus: AwbAssignmentStatus = row.assignmentStatus === "planned"
    ? "planned"
    : row.assignmentStatus === "assigned" || assigneeType !== null
      ? "assigned"
      : "planned";
  return { assignmentStatus, assigneeType, assigneeId, assigneeName };
}

function stateFor(assignmentStatus: AwbAssignmentStatus, unusedCount: number): AwbBatchState {
  return unusedCount === 0 ? "depleted" : assignmentStatus;
}

type PlannedBatchInsert = Omit<typeof awbBatch.$inferInsert, "createdById" | "createdByName">;

function generateDrafts(batchCount: number, numbersPerBatch: number, startingTrackingNumber?: string) {
  const drafts: { row: PlannedBatchInsert; labels: string[] }[] = [];
  const seen = new Set<string>();
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const plannedRanges = startingTrackingNumber === undefined
    ? null
    : planAwbBatchRanges(batchCount, numbersPerBatch, startingTrackingNumber);
  for (let index = 0; index < batchCount; index += 1) {
    const labels = plannedRanges?.[index]?.labels ?? createAwbSeries(randomAwbSeriesStart(numbersPerBatch), numbersPerBatch);
    if (labels.some((awb) => seen.has(awb))) return null;
    for (const awb of labels) seen.add(awb);

    const id = prefixedId("awb");
    const awbStart = labels[0]!;
    const awbEnd = labels.at(-1)!;
    drafts.push({
      row: {
        id,
        batchCode: `NXB-${datePart}-${id.slice(-10)}`,
        // Legacy columns remain populated for schema compatibility. New batches
        // are unassigned until admin attaches an assignee below.
        merchantId: "",
        merchantName: "",
        assignmentStatus: "planned",
        assigneeType: null,
        assigneeId: null,
        assigneeName: null,
        assignedAt: null,
        assignedById: null,
        assignedByName: null,
        awbStart,
        awbEnd,
        labelCount: numbersPerBatch,
      },
      labels,
    });
  }
  return drafts;
}

/** Give pre-feature batches stable numeric IDs, in their original creation order. */
async function ensureSeriesNumbers(): Promise<void> {
  await db.transaction(async (tx) => {
    const missing = await tx
      .select({ batchId: awbBatch.id })
      .from(awbBatch)
      .leftJoin(awbBatchSeries, eq(awbBatchSeries.batchId, awbBatch.id))
      .where(isNull(awbBatchSeries.batchId))
      .orderBy(asc(awbBatch.createdAt), asc(awbBatch.id));
    for (const row of missing) {
      await tx
        .insert(awbBatchSeries)
        .values({ batchId: row.batchId })
        .onConflictDoNothing({ target: awbBatchSeries.batchId });
    }
  });
}

/** Read all batches and count parcels created with each batch's reserved tracking numbers. */
export async function listAwbBatches() {
  await ensureSeriesNumbers();
  const rows = await db
    .select({
      id: awbBatch.id,
      seriesNumber: awbBatchSeries.seriesNumber,
      batchCode: awbBatch.batchCode,
      merchantId: awbBatch.merchantId,
      merchantName: awbBatch.merchantName,
      assignmentStatus: awbBatch.assignmentStatus,
      assigneeType: awbBatch.assigneeType,
      assigneeId: awbBatch.assigneeId,
      assigneeName: awbBatch.assigneeName,
      assignedAt: awbBatch.assignedAt,
      assignedById: awbBatch.assignedById,
      assignedByName: awbBatch.assignedByName,
      awbStart: awbBatch.awbStart,
      awbEnd: awbBatch.awbEnd,
      labelCount: awbBatch.labelCount,
      createdByName: awbBatch.createdByName,
      createdAt: awbBatch.createdAt,
      usedCount: sql<number>`sum(case when ${parcel.id} is not null then 1 else 0 end)`,
      retiredCount: sql<number>`sum(case when ${parcel.id} is null and ${retiredTrackingNumber.trackingNumber} is not null then 1 else 0 end)`,
    })
    .from(awbBatch)
    .innerJoin(awbBatchSeries, eq(awbBatchSeries.batchId, awbBatch.id))
    .leftJoin(awbBatchLabel, eq(awbBatchLabel.batchId, awbBatch.id))
    .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
    .leftJoin(retiredTrackingNumber, eq(retiredTrackingNumber.trackingNumber, awbBatchLabel.awb))
    .groupBy(awbBatch.id, awbBatchSeries.seriesNumber)
    .orderBy(desc(awbBatch.createdAt), desc(awbBatch.id));

  return rows.map((row) => {
    const assignment = assignmentFor(row);
    const unusedCount = Math.max(0, row.labelCount - row.usedCount - row.retiredCount);
    return { ...row, ...assignment, status: stateFor(assignment.assignmentStatus, unusedCount), unusedCount };
  });
}

/** Generate an atomic set of planned batches. The two-argument form remains a legacy 1,000-label random allocation. */
export function createAwbBatches(batchCount: number, actor: Principal): Promise<AwbBatchWithSeries[]>;
export function createAwbBatches(batchCount: number, numbersPerBatch: number, startingTrackingNumber: string, actor: Principal): Promise<AwbBatchWithSeries[]>;
export async function createAwbBatches(
  batchCount: number,
  numbersPerBatchOrActor: number | Principal,
  startingTrackingNumberOrActor?: string | Principal,
  suppliedActor?: Principal,
): Promise<AwbBatchWithSeries[]> {
  const legacy = typeof numbersPerBatchOrActor !== "number";
  const numbersPerBatch = legacy ? AWB_LABELS_PER_BATCH : numbersPerBatchOrActor;
  const startingTrackingNumber = legacy ? undefined : startingTrackingNumberOrActor as string | undefined;
  const actor = legacy ? numbersPerBatchOrActor : suppliedActor;
  if (!actor || typeof actor === "number") throw new Error("An allocation actor is required.");
  if (!Number.isInteger(batchCount) || batchCount < 1 || batchCount > MAX_BATCHES_PER_GENERATION) {
    errors.badRequest(`Generate between 1 and ${MAX_BATCHES_PER_GENERATION} batches at a time.`);
  }
  if (!Number.isInteger(numbersPerBatch) || numbersPerBatch < 1 || numbersPerBatch > MAX_NUMBERS_PER_BATCH) {
    errors.badRequest(`Numbers per batch must be between 1 and ${MAX_NUMBERS_PER_BATCH.toLocaleString()}.`);
  }
  if (batchCount * numbersPerBatch > MAX_LABELS_PER_GENERATION) {
    errors.badRequest(`A generation may reserve at most ${MAX_LABELS_PER_GENERATION.toLocaleString()} tracking numbers.`);
  }

  await ensureSeriesNumbers();
  let initialDrafts: ReturnType<typeof generateDrafts>;
  try {
    initialDrafts = generateDrafts(batchCount, numbersPerBatch, startingTrackingNumber);
  } catch (error) {
    if (error instanceof RangeError) errors.badRequest(error.message);
    throw error;
  }
  if (!initialDrafts) return errors.conflict("Could not reserve unique tracking number ranges. Retry batch generation.");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const drafts = startingTrackingNumber === undefined
      ? attempt === 0 ? initialDrafts : generateDrafts(batchCount, numbersPerBatch)
      : initialDrafts;
    if (!drafts) continue;
    try {
      return await db.transaction(async (tx) => {
        for (const { row } of drafts) {
          const [parcelClash] = await tx
            .select({ id: parcel.id })
            .from(parcel)
            .where(and(gte(parcel.awb, row.awbStart), lte(parcel.awb, row.awbEnd)))
            .limit(1);
          if (parcelClash) throw new AwbRangeOccupied();

          const [labelClash] = await tx
            .select({ awb: awbBatchLabel.awb })
            .from(awbBatchLabel)
            .where(and(gte(awbBatchLabel.awb, row.awbStart), lte(awbBatchLabel.awb, row.awbEnd)))
            .limit(1);
          if (labelClash) throw new AwbRangeOccupied();

          const [retiredClash] = await tx
            .select({ trackingNumber: retiredTrackingNumber.trackingNumber })
            .from(retiredTrackingNumber)
            .where(and(gte(retiredTrackingNumber.trackingNumber, row.awbStart), lte(retiredTrackingNumber.trackingNumber, row.awbEnd)))
            .limit(1);
          if (retiredClash) throw new AwbRangeOccupied();
        }

        const created: AwbBatchWithSeries[] = [];
        for (const draft of drafts) {
          const [saved] = await tx.insert(awbBatch).values({
            ...draft.row,
            createdById: actor.userId,
            createdByName: actor.name,
            createdAt: new Date(),
          }).returning();
          if (!saved) throw new Error("The tracking number batch was not saved.");
          const [series] = await tx
            .insert(awbBatchSeries)
            .values({ batchId: saved.id })
            .returning({ seriesNumber: awbBatchSeries.seriesNumber });
          if (!series) throw new Error("The tracking number series number was not saved.");
          for (let start = 0; start < draft.labels.length; start += LABEL_INSERT_CHUNK) {
            await tx.insert(awbBatchLabel).values(
              draft.labels.slice(start, start + LABEL_INSERT_CHUNK).map((awb) => ({ awb, batchId: saved.id })),
            );
          }
          created.push({ ...saved, seriesNumber: series.seriesNumber });
        }
        return created;
      });
    } catch (error) {
      if (startingTrackingNumber !== undefined && (error instanceof AwbRangeOccupied || isReservationConflict(error))) {
        return errors.conflict("One or more requested tracking number ranges are already reserved; no batch was created.");
      }
      if (error instanceof AwbRangeOccupied || isReservationConflict(error)) continue;
      throw error;
    }
  }
  return errors.conflict("Could not reserve unique tracking number ranges. Retry batch generation.");
}

/** Assign a planned batch once, with an immutable target snapshot and audit actor. */
export async function assignAwbBatch(
  batchId: string,
  assigneeType: AwbAssigneeType,
  assigneeId: string,
  actor: Principal,
) {
  if (actor.role !== "admin") errors.forbidden("Only an admin can assign a tracking number batch.");
  await ensureSeriesNumbers();
  let assigneeName: string;
  if (assigneeType === "merchant") {
    const owner = await getMerchant(assigneeId);
    if (!owner) errors.notFound(`Merchant ${assigneeId}`);
    if (owner!.status !== "active") errors.conflict(`Merchant ${owner!.name} is ${owner!.status}; a label batch cannot be assigned.`);
    assigneeName = owner!.name;
  } else {
    const location = await getBranch(assigneeId);
    if (!location || location.type !== assigneeType) errors.notFound(`${assigneeType} ${assigneeId}`);
    if (location!.status !== "active") errors.conflict(`Branch/hub ${location!.name} is inactive; a label batch cannot be assigned.`);
    assigneeName = location!.name;
  }

  return db.transaction((tx) => assignAwbBatchInTransaction(batchId, assigneeType, assigneeId, assigneeName, actor, tx));
}

/** Assign a batch to a merchant created in the caller's onboarding transaction. */
export async function assignAwbBatchToNewMerchant(
  batchId: string,
  merchantOwner: { id: string; name: string; status: string },
  actor: Principal,
  executor: DbTransaction,
) {
  if (actor.role !== "admin") errors.forbidden("Only an admin can assign a tracking number batch.");
  if (merchantOwner.status !== "active") errors.conflict("A tracking number batch can only be assigned to an active merchant.");
  return assignAwbBatchInTransaction(batchId, "merchant", merchantOwner.id, merchantOwner.name, actor, executor);
}

async function assignAwbBatchInTransaction(
  batchId: string,
  assigneeType: AwbAssigneeType,
  assigneeId: string,
  assigneeName: string,
  actor: Principal,
  tx: DbTransaction,
) {
    const [batch] = await tx.select().from(awbBatch).where(eq(awbBatch.id, batchId)).limit(1);
    if (!batch) errors.notFound("tracking number batch");
    if (batch!.assignmentStatus !== "planned") {
      errors.conflict("Only planned, unassigned batches can be assigned.");
    }

      const [usage] = await tx
        .select({ usedCount: count() })
        .from(awbBatchLabel)
        .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
        .leftJoin(retiredTrackingNumber, eq(retiredTrackingNumber.trackingNumber, awbBatchLabel.awb))
        .where(and(eq(awbBatchLabel.batchId, batchId), or(isNotNull(parcel.id), isNotNull(retiredTrackingNumber.trackingNumber))));
    if ((usage?.usedCount ?? 0) > 0) errors.conflict("A batch with booked or retired tracking numbers cannot be assigned.");

    const now = new Date();
    const [saved] = await tx
      .update(awbBatch)
      .set({
        assignmentStatus: "assigned",
        assigneeType,
        assigneeId,
        assigneeName,
        assignedAt: now,
        assignedById: actor.userId,
        assignedByName: actor.name,
        merchantId: assigneeType === "merchant" ? assigneeId : "",
        merchantName: assigneeType === "merchant" ? assigneeName : "",
      })
      .where(and(eq(awbBatch.id, batchId), eq(awbBatch.assignmentStatus, "planned")))
      .returning();
    if (!saved) errors.conflict("This batch was already assigned. Refresh and try again.");
    const [series] = await tx
      .select({ seriesNumber: awbBatchSeries.seriesNumber })
      .from(awbBatchSeries)
      .where(eq(awbBatchSeries.batchId, saved!.id))
      .limit(1);
    if (!series) throw new Error("The tracking number series number is missing.");
    return { ...saved!, seriesNumber: series.seriesNumber, ...assignmentFor(saved!), usedCount: 0, retiredCount: 0, unusedCount: saved!.labelCount, status: "assigned" as const };
}

/** Latest merchant-owned range for a welcome SMS; never returns credentials. */
export async function latestMerchantAwbAllocation(merchantId: string) {
  const [row] = await db
    .select({
      batchId: awbBatch.id,
      seriesNumber: awbBatchSeries.seriesNumber,
      awbStart: awbBatch.awbStart,
      awbEnd: awbBatch.awbEnd,
      labelCount: awbBatch.labelCount,
    })
    .from(awbBatch)
    .innerJoin(awbBatchSeries, eq(awbBatchSeries.batchId, awbBatch.id))
    .where(and(
      eq(awbBatch.assignmentStatus, "assigned"),
      eq(awbBatch.assigneeType, "merchant"),
      eq(awbBatch.assigneeId, merchantId),
    ))
    .orderBy(desc(awbBatch.assignedAt), desc(awbBatch.createdAt))
    .limit(1);
  return row ?? null;
}

/** Lock and recheck a reserved tracking number inside its booking transaction. */
export async function lockAndAssertAwbAvailableForBooking(tx: DbTransaction, awb: string): Promise<void> {
  const batchIds = tx
    .select({ batchId: awbBatchLabel.batchId })
    .from(awbBatchLabel)
    .where(eq(awbBatchLabel.awb, awb));
  // Both booking and retirement update the same stable batch row first. SQLite
  // serializes these writes, so only the operation that commits first can win.
  await tx
    .update(awbBatch)
    .set({ createdAt: sql`${awbBatch.createdAt}` })
    .where(inArray(awbBatch.id, batchIds));

  const [retired] = await tx
    .select({ trackingNumber: retiredTrackingNumber.trackingNumber })
    .from(retiredTrackingNumber)
    .where(eq(retiredTrackingNumber.trackingNumber, awb))
    .limit(1);
  if (retired) errors.conflict("This tracking number has been retired and cannot be used.", { awb });

  const [used] = await tx.select({ id: parcel.id }).from(parcel).where(eq(parcel.awb, awb)).limit(1);
  if (used) errors.conflict("This tracking number was just used by another booking. Scan or enter a different sticker.", { awb });
}

/** Retire all unused labels while preserving every booked label and batch record. */
export async function retireAwbBatch(batchId: string, _actor: Principal) {
  await ensureSeriesNumbers();
  return db.transaction(async (tx) => {
    // Acquire the same write lock as createParcel before reading parcel usage.
    const [batch] = await tx
      .update(awbBatch)
      .set({ createdAt: sql`${awbBatch.createdAt}` })
      .where(eq(awbBatch.id, batchId))
      .returning();
    if (!batch) errors.notFound("tracking number batch");
    const [series] = await tx
      .select({ seriesNumber: awbBatchSeries.seriesNumber })
      .from(awbBatchSeries)
      .where(eq(awbBatchSeries.batchId, batchId))
      .limit(1);
    if (!series) throw new Error("The tracking number series number is missing.");
    const labels = await tx
      .select({ awb: awbBatchLabel.awb, parcelId: parcel.id, retiredNumber: retiredTrackingNumber.trackingNumber })
      .from(awbBatchLabel)
      .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
      .leftJoin(retiredTrackingNumber, eq(retiredTrackingNumber.trackingNumber, awbBatchLabel.awb))
      .where(eq(awbBatchLabel.batchId, batchId))
      .orderBy(asc(awbBatchLabel.awb));
    const unused = labels.filter((label) => label.parcelId === null && label.retiredNumber === null);
    if (!unused.length) errors.conflict("This batch has no unused tracking numbers to retire.");
    let retiredCount = 0;
    for (let start = 0; start < unused.length; start += LABEL_INSERT_CHUNK) {
      const retired = await tx
        .insert(retiredTrackingNumber)
        .values(unused.slice(start, start + LABEL_INSERT_CHUNK).map(({ awb }) => ({
          trackingNumber: awb,
          reason: `Retired unused label from batch ${batch!.batchCode} (${batch!.id})`,
        })))
        .onConflictDoNothing({ target: retiredTrackingNumber.trackingNumber })
        .returning({ trackingNumber: retiredTrackingNumber.trackingNumber });
      retiredCount += retired.length;
    }
    return {
      batchId: batch!.id,
      batchCode: batch!.batchCode,
      seriesNumber: series.seriesNumber,
      awbStart: batch!.awbStart,
      awbEnd: batch!.awbEnd,
      retiredCount,
      usedCount: labels.filter((label) => label.parcelId !== null).length,
      alreadyRetiredCount: labels.filter((label) => label.retiredNumber !== null).length,
    };
  });
}

/** Next unused label: merchant stock when applicable, then branch/hub stock. */
export async function nextUnusedAwbForBooking(merchantId: string | null, branchId: string): Promise<string | null> {
  const [merchantLabel] = merchantId ? await db
    .select({ awb: awbBatchLabel.awb })
    .from(awbBatchLabel)
    .innerJoin(awbBatch, eq(awbBatch.id, awbBatchLabel.batchId))
    .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
    .leftJoin(retiredTrackingNumber, eq(retiredTrackingNumber.trackingNumber, awbBatchLabel.awb))
    .where(and(
      eq(awbBatch.merchantId, merchantId),
      or(isNull(awbBatch.assignmentStatus), eq(awbBatch.assignmentStatus, "assigned")),
      isNull(parcel.id),
      isNull(retiredTrackingNumber.trackingNumber),
    ))
    .orderBy(asc(awbBatch.createdAt), asc(awbBatchLabel.awb))
    .limit(1) : [];
  if (merchantLabel) return merchantLabel.awb;

  const [locationLabel] = await db
    .select({ awb: awbBatchLabel.awb })
    .from(awbBatchLabel)
    .innerJoin(awbBatch, eq(awbBatch.id, awbBatchLabel.batchId))
    .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
    .leftJoin(retiredTrackingNumber, eq(retiredTrackingNumber.trackingNumber, awbBatchLabel.awb))
    .where(and(
      eq(awbBatch.assignmentStatus, "assigned"),
      inArray(awbBatch.assigneeType, ["branch", "hub"]),
      eq(awbBatch.assigneeId, branchId),
      isNull(parcel.id),
      isNull(retiredTrackingNumber.trackingNumber),
    ))
    .orderBy(asc(awbBatch.createdAt), asc(awbBatchLabel.awb))
    .limit(1);
  return locationLabel?.awb ?? null;
}

/** Check supplied stickers without revealing any other merchant's inventory. */
export async function checkMerchantAwbs(merchantId: string, values: string[]) {
  const awbs = values.map((value) => value.trim().toUpperCase());
  const syntacticallyValid = [...new Set(awbs.filter((awb) => /^NX\d{10}$/.test(awb)))];
  const labels = syntacticallyValid.length
    ? await db
    .select({ awb: awbBatchLabel.awb, usedParcelId: parcel.id, retiredNumber: retiredTrackingNumber.trackingNumber })
    .from(awbBatchLabel)
    .innerJoin(awbBatch, eq(awbBatch.id, awbBatchLabel.batchId))
    .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
    .leftJoin(retiredTrackingNumber, eq(retiredTrackingNumber.trackingNumber, awbBatchLabel.awb))
    .where(and(
      inArray(awbBatchLabel.awb, syntacticallyValid),
      or(
        and(
          eq(awbBatch.assignmentStatus, "assigned"),
          eq(awbBatch.assigneeType, "merchant"),
          eq(awbBatch.assigneeId, merchantId),
        ),
        and(isNull(awbBatch.assignmentStatus), eq(awbBatch.merchantId, merchantId)),
      ),
    ))
    : [];
  const byAwb = new Map(labels.map((label) => [label.awb, label]));

  return awbs.map((awb) => {
    if (!/^NX\d{10}$/.test(awb)) return { valid: false as const, awb, reason: "Enter a valid 12-character NX tracking number from your sticker." };
    const label = byAwb.get(awb);
    if (!label) return { valid: false as const, awb, reason: "This tracking number is not in the sticker batches allocated to your merchant." };
    if (label.retiredNumber) return { valid: false as const, awb, reason: "This tracking number has been retired and cannot be used." };
    if (label.usedParcelId) return { valid: false as const, awb, reason: "This tracking number has already been used. Scan or enter an unused sticker." };
    return { valid: true as const, awb, reason: "Tracking number is allocated to your merchant and available." };
  });
}

/** Check a single typed/scanned sticker. */
export async function checkMerchantAwb(merchantId: string, value: string) {
  return (await checkMerchantAwbs(merchantId, [value]))[0]!;
}

/** Walk-in counter labels must come from the branch/hub's own assigned stock. */
export async function checkBranchAwb(branchId: string, value: string) {
  const awb = value.trim().toUpperCase();
  if (!/^NX\d{10}$/.test(awb)) {
    return { valid: false as const, awb, reason: "Enter a valid 12-character NX tracking number from the branch sticker stock." };
  }
  const [label] = await db
    .select({ awb: awbBatchLabel.awb, usedParcelId: parcel.id, retiredNumber: retiredTrackingNumber.trackingNumber })
    .from(awbBatchLabel)
    .innerJoin(awbBatch, eq(awbBatch.id, awbBatchLabel.batchId))
    .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
    .leftJoin(retiredTrackingNumber, eq(retiredTrackingNumber.trackingNumber, awbBatchLabel.awb))
    .where(and(
      eq(awbBatchLabel.awb, awb),
      eq(awbBatch.assignmentStatus, "assigned"),
      inArray(awbBatch.assigneeType, ["branch", "hub"]),
      eq(awbBatch.assigneeId, branchId),
    ))
    .limit(1);
  if (!label) return { valid: false as const, awb, reason: "This tracking number is not allocated to this branch or hub." };
  if (label.retiredNumber) return { valid: false as const, awb, reason: "This tracking number has been retired and cannot be used." };
  if (label.usedParcelId) return { valid: false as const, awb, reason: "This tracking number has already been used. Scan an unused branch sticker." };
  return { valid: true as const, awb, reason: "Tracking number is allocated to this branch and available." };
}

/** A batch plus per-label use state, for Excel-compatible or print/PDF export. */
export async function labelsForAwbBatch(batchId: string) {
  await ensureSeriesNumbers();
  const [batch] = await db.select().from(awbBatch).where(eq(awbBatch.id, batchId)).limit(1);
  if (!batch) errors.notFound("tracking number batch");
  const [series] = await db
    .select({ seriesNumber: awbBatchSeries.seriesNumber })
    .from(awbBatchSeries)
    .where(eq(awbBatchSeries.batchId, batchId))
    .limit(1);
  if (!series) throw new Error("The tracking number series number is missing.");
  const labels = await db
    .select({ awb: awbBatchLabel.awb, parcelId: parcel.id, retiredNumber: retiredTrackingNumber.trackingNumber })
    .from(awbBatchLabel)
    .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
    .leftJoin(retiredTrackingNumber, eq(retiredTrackingNumber.trackingNumber, awbBatchLabel.awb))
    .where(eq(awbBatchLabel.batchId, batchId))
    .orderBy(asc(awbBatchLabel.awb));
  const usedCount = labels.reduce((total, label) => total + (label.parcelId === null ? 0 : 1), 0);
  const retiredCount = labels.reduce((total, label) => total + (label.parcelId === null && label.retiredNumber !== null ? 1 : 0), 0);
  const unusedCount = Math.max(0, batch!.labelCount - usedCount - retiredCount);
  const assignment = assignmentFor(batch!);
  return {
    batch: { ...batch!, seriesNumber: series.seriesNumber, ...assignment, usedCount, retiredCount, unusedCount, status: stateFor(assignment.assignmentStatus, unusedCount) },
    labels: labels.map(({ awb, parcelId, retiredNumber }) => ({ awb, used: parcelId !== null || retiredNumber !== null, retired: retiredNumber !== null })),
  };
}
