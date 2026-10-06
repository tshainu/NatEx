import { and, asc, count, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { db } from "../../database";
import { awbBatch, awbBatchLabel, parcel } from "../../database/schema/parcels";
import { getMerchant } from "../merchants/service";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import type { Principal } from "../../shared/auth";
import { AWB_LABELS_PER_BATCH, createAwbSeries, randomAwbSeriesStart } from "./awb-series";

const LABEL_INSERT_CHUNK = 200;

export type AwbBatchRow = typeof awbBatch.$inferSelect;

class AwbRangeOccupied extends Error {}

function isUniqueLabelError(error: unknown): boolean {
  const message = errorChainText(error);
  return message.includes("UNIQUE constraint failed: parcels_awb_batch_label.awb") ||
    (message.includes("SQLITE_CONSTRAINT") && message.includes("parcels_awb_batch_label.awb"));
}

function errorChainText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  return `${error.message} ${cause === undefined ? "" : errorChainText(cause)}`;
}

/** Read all batches and count parcels created with each batch's reserved AWBs. */
export async function listAwbBatches() {
  const rows = await db
    .select({
      id: awbBatch.id,
      batchCode: awbBatch.batchCode,
      merchantId: awbBatch.merchantId,
      merchantName: awbBatch.merchantName,
      awbStart: awbBatch.awbStart,
      awbEnd: awbBatch.awbEnd,
      labelCount: awbBatch.labelCount,
      createdByName: awbBatch.createdByName,
      createdAt: awbBatch.createdAt,
      usedCount: count(parcel.id),
    })
    .from(awbBatch)
    .leftJoin(awbBatchLabel, eq(awbBatchLabel.batchId, awbBatch.id))
    .leftJoin(
      parcel,
      and(eq(parcel.awb, awbBatchLabel.awb), eq(parcel.merchantId, awbBatch.merchantId)),
    )
    .groupBy(awbBatch.id)
    .orderBy(desc(awbBatch.createdAt), desc(awbBatch.id));
  return rows.map((row) => ({
    ...row,
    unusedCount: Math.max(0, row.labelCount - row.usedCount),
  }));
}

/** Issue a new fixed series and reserve every number atomically. */
export async function createAwbBatch(merchantId: string, actor: Principal): Promise<AwbBatchRow> {
  const owner = await getMerchant(merchantId);
  if (!owner) errors.notFound(`Merchant ${merchantId}`);
  if (owner!.status !== "active") {
    errors.conflict(`Merchant ${owner!.name} is ${owner!.status}; a label batch cannot be issued.`);
  }

  const batchId = prefixedId("awb");
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const batchCode = `NXB-${datePart}-${batchId.slice(-10)}`;
  const createdAt = new Date();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const labels = createAwbSeries(randomAwbSeriesStart(), AWB_LABELS_PER_BATCH);
    const awbStart = labels[0]!;
    const awbEnd = labels.at(-1)!;
    try {
      return await db.transaction(async (tx) => {
        const [parcelClash] = await tx
          .select({ id: parcel.id })
          .from(parcel)
          .where(and(gte(parcel.awb, awbStart), lte(parcel.awb, awbEnd)))
          .limit(1);
        if (parcelClash) throw new AwbRangeOccupied();

        const [labelClash] = await tx
          .select({ awb: awbBatchLabel.awb })
          .from(awbBatchLabel)
          .where(and(gte(awbBatchLabel.awb, awbStart), lte(awbBatchLabel.awb, awbEnd)))
          .limit(1);
        if (labelClash) throw new AwbRangeOccupied();

        const [saved] = await tx
          .insert(awbBatch)
          .values({
            id: batchId,
            batchCode,
            merchantId: owner!.id,
            merchantName: owner!.name,
            awbStart,
            awbEnd,
            labelCount: AWB_LABELS_PER_BATCH,
            createdById: actor.userId,
            createdByName: actor.name,
            createdAt,
          })
          .returning();

        for (let start = 0; start < labels.length; start += LABEL_INSERT_CHUNK) {
          await tx.insert(awbBatchLabel).values(
            labels.slice(start, start + LABEL_INSERT_CHUNK).map((awb) => ({ awb, batchId })),
          );
        }
        return saved!;
      });
    } catch (error) {
      if (error instanceof AwbRangeOccupied || isUniqueLabelError(error)) continue;
      throw error;
    }
  }
  return errors.conflict("Could not reserve a unique AWB range. Retry batch generation.");
}

/** The oldest unconsumed reserved sticker for this merchant, if any. */
export async function nextUnusedMerchantAwb(merchantId: string): Promise<string | null> {
  const [row] = await db
    .select({ awb: awbBatchLabel.awb })
    .from(awbBatchLabel)
    .innerJoin(awbBatch, eq(awbBatch.id, awbBatchLabel.batchId))
    .leftJoin(parcel, eq(parcel.awb, awbBatchLabel.awb))
    .where(and(eq(awbBatch.merchantId, merchantId), isNull(parcel.id)))
    .orderBy(asc(awbBatch.createdAt), asc(awbBatchLabel.awb))
    .limit(1);
  return row?.awb ?? null;
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
  return {
    batch: batch!,
    labels: labels.map(({ awb, parcelId }) => ({ awb, used: parcelId !== null })),
  };
}
