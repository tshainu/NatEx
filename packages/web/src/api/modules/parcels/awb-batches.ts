import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "../../database";
import { awbBatch, awbBatchLabel, parcel } from "../../database/schema/parcels";
import { getMerchant } from "../merchants/service";
import { getBranch } from "../identity/service";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import type { Principal } from "../../shared/auth";
import { AWB_LABELS_PER_BATCH, createAwbSeries, randomAwbSeriesStart } from "./awb-series";

const LABEL_INSERT_CHUNK = 200;
export const MAX_BATCHES_PER_GENERATION = 50;

export type AwbBatchRow = typeof awbBatch.$inferSelect;
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

function generateDrafts(batchCount: number) {
  const drafts: { row: PlannedBatchInsert; labels: string[] }[] = [];
  const seen = new Set<string>();
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  for (let index = 0; index < batchCount; index += 1) {
    const labels = createAwbSeries(randomAwbSeriesStart(), AWB_LABELS_PER_BATCH);
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
        labelCount: AWB_LABELS_PER_BATCH,
      },
      labels,
    });
  }
  return drafts;
}

/** Read all batches and count parcels created with each batch's reserved AWBs. */
export async function listAwbBatches() {
  const rows = await db
    .select({
      id: awbBatch.id,
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
      usedCount: count(parcel.id),
    })
    .from(awbBatch)
    .leftJoin(awbBatchLabel, eq(awbBatchLabel.batchId, awbBatch.id))
    .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
    .groupBy(awbBatch.id)
    .orderBy(desc(awbBatch.createdAt), desc(awbBatch.id));

  return rows.map((row) => {
    const assignment = assignmentFor(row);
    const unusedCount = Math.max(0, row.labelCount - row.usedCount);
    return { ...row, ...assignment, status: stateFor(assignment.assignmentStatus, unusedCount), unusedCount };
  });
}

/** Generate an atomic set of planned batches; each contains exactly 1,000 labels. */
export async function createAwbBatches(batchCount: number, actor: Principal): Promise<AwbBatchRow[]> {
  if (!Number.isInteger(batchCount) || batchCount < 1 || batchCount > MAX_BATCHES_PER_GENERATION) {
    errors.badRequest(`Generate between 1 and ${MAX_BATCHES_PER_GENERATION} batches at a time.`);
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const drafts = generateDrafts(batchCount);
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
        }

        const created: AwbBatchRow[] = [];
        for (const draft of drafts) {
          const [saved] = await tx.insert(awbBatch).values({
            ...draft.row,
            createdById: actor.userId,
            createdByName: actor.name,
            createdAt: new Date(),
          }).returning();
          if (!saved) throw new Error("The AWB batch was not saved.");
          for (let start = 0; start < draft.labels.length; start += LABEL_INSERT_CHUNK) {
            await tx.insert(awbBatchLabel).values(
              draft.labels.slice(start, start + LABEL_INSERT_CHUNK).map((awb) => ({ awb, batchId: saved.id })),
            );
          }
          created.push(saved);
        }
        return created;
      });
    } catch (error) {
      if (error instanceof AwbRangeOccupied || isReservationConflict(error)) continue;
      throw error;
    }
  }
  return errors.conflict("Could not reserve unique AWB ranges. Retry batch generation.");
}

/** Assign a planned batch once, with an immutable target snapshot and audit actor. */
export async function assignAwbBatch(
  batchId: string,
  assigneeType: AwbAssigneeType,
  assigneeId: string,
  actor: Principal,
) {
  let assigneeName: string;
  if (assigneeType === "merchant") {
    const owner = await getMerchant(assigneeId);
    if (!owner) errors.notFound(`Merchant ${assigneeId}`);
    if (owner!.status !== "active") errors.conflict(`Merchant ${owner!.name} is ${owner!.status}; a label batch cannot be assigned.`);
    assigneeName = owner!.name;
  } else {
    const location = await getBranch(assigneeId);
    if (!location || location.type !== assigneeType) errors.notFound(`${assigneeType} ${assigneeId}`);
    assigneeName = location!.name;
  }

  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(awbBatch).where(eq(awbBatch.id, batchId)).limit(1);
    if (!batch) errors.notFound("AWB batch");
    if (batch!.assignmentStatus !== "planned") {
      errors.conflict("Only planned, unassigned batches can be assigned.");
    }

    const [usage] = await tx
      .select({ usedCount: count() })
      .from(awbBatchLabel)
      .innerJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
      .where(eq(awbBatchLabel.batchId, batchId));
    if ((usage?.usedCount ?? 0) > 0) errors.conflict("A batch with booked AWBs cannot be assigned.");

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
    return { ...saved!, ...assignmentFor(saved!), usedCount: 0, unusedCount: saved!.labelCount, status: "assigned" as const };
  });
}

/** Next unused label: merchant-owned stock first, then the parcel's assigned branch/hub stock. */
export async function nextUnusedAwbForBooking(merchantId: string, branchId: string): Promise<string | null> {
  const [merchantLabel] = await db
    .select({ awb: awbBatchLabel.awb })
    .from(awbBatchLabel)
    .innerJoin(awbBatch, eq(awbBatch.id, awbBatchLabel.batchId))
    .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
    .where(and(
      eq(awbBatch.merchantId, merchantId),
      or(isNull(awbBatch.assignmentStatus), eq(awbBatch.assignmentStatus, "assigned")),
      isNull(parcel.id),
    ))
    .orderBy(asc(awbBatch.createdAt), asc(awbBatchLabel.awb))
    .limit(1);
  if (merchantLabel) return merchantLabel.awb;

  const [locationLabel] = await db
    .select({ awb: awbBatchLabel.awb })
    .from(awbBatchLabel)
    .innerJoin(awbBatch, eq(awbBatch.id, awbBatchLabel.batchId))
    .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
    .where(and(
      eq(awbBatch.assignmentStatus, "assigned"),
      inArray(awbBatch.assigneeType, ["branch", "hub"]),
      eq(awbBatch.assigneeId, branchId),
      isNull(parcel.id),
    ))
    .orderBy(asc(awbBatch.createdAt), asc(awbBatchLabel.awb))
    .limit(1);
  return locationLabel?.awb ?? null;
}

/** A batch plus per-label use state, for Excel-compatible or print/PDF export. */
export async function labelsForAwbBatch(batchId: string) {
  const [batch] = await db.select().from(awbBatch).where(eq(awbBatch.id, batchId)).limit(1);
  if (!batch) errors.notFound("AWB batch");
  const labels = await db
    .select({ awb: awbBatchLabel.awb, parcelId: parcel.id })
    .from(awbBatchLabel)
    .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
    .where(eq(awbBatchLabel.batchId, batchId))
    .orderBy(asc(awbBatchLabel.awb));
  const usedCount = labels.reduce((total, label) => total + (label.parcelId === null ? 0 : 1), 0);
  const unusedCount = Math.max(0, batch!.labelCount - usedCount);
  const assignment = assignmentFor(batch!);
  return {
    batch: { ...batch!, ...assignment, usedCount, unusedCount, status: stateFor(assignment.assignmentStatus, unusedCount) },
    labels: labels.map(({ awb, parcelId }) => ({ awb, used: parcelId !== null })),
  };
}
