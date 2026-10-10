import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../database";
import { manifest, manifestItem } from "../../database/schema/collection";
import { insertWithFreshCode, mintDocumentCode } from "../../shared/codes";
import { prefixedId } from "../../shared/ulid";
import { colomboToday } from "../../shared/time";

const OPEN_MANIFEST_STATUSES = ["assigned", "in_progress"] as const;

export interface AutoPickupAssignmentInput {
  merchantId: string;
  merchantName: string;
  branchId: string;
  riderId: string;
  parcelId: string;
  awb: string;
}

/**
 * Add a just-booked merchant parcel to that merchant's open, default-rider
 * manifest for today. A unique autoKey groups concurrent bookings safely; it is
 * released when the Rider completes the formal handover.
 */
export async function addBookingToAutoManifest(input: AutoPickupAssignmentInput) {
  const pickupDate = colomboToday();
  const autoKey = JSON.stringify([input.merchantId, input.riderId, pickupDate]);

  const appendTo = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], manifestId: string, code: string) => {
    const [existing] = await tx
      .select({ id: manifestItem.id })
      .from(manifestItem)
      .innerJoin(manifest, eq(manifest.id, manifestItem.manifestId))
      .where(and(eq(manifestItem.parcelId, input.parcelId), eq(manifest.id, manifestId)))
      .limit(1);
    if (existing) return { manifestId, code };

    await tx.insert(manifestItem).values({
      id: prefixedId("mfi"),
      manifestId,
      parcelId: input.parcelId,
      awb: input.awb,
    });
    await tx
      .update(manifest)
      .set({ expectedCount: sql`${manifest.expectedCount} + 1` })
      .where(and(eq(manifest.id, manifestId), inArray(manifest.status, [...OPEN_MANIFEST_STATUSES])));
    return { manifestId, code };
  };

  try {
    return await db.transaction(async (tx) => {
      const [priorAssignment] = await tx
        .select({ manifestId: manifest.id, code: manifest.code })
        .from(manifestItem)
        .innerJoin(manifest, eq(manifest.id, manifestItem.manifestId))
        .where(and(eq(manifestItem.parcelId, input.parcelId), ne(manifest.status, "cancelled")))
        .limit(1);
      if (priorAssignment) return { manifestId: priorAssignment.manifestId, code: priorAssignment.code };

      const [active] = await tx
        .select({ id: manifest.id, code: manifest.code })
        .from(manifest)
        .where(and(eq(manifest.autoKey, autoKey), inArray(manifest.status, [...OPEN_MANIFEST_STATUSES])))
        .limit(1);
      if (active) return appendTo(tx, active.id, active.code);

      const manifestId = prefixedId("mfs");
      const { code } = await insertWithFreshCode(
        "collection_manifest",
        () => mintDocumentCode("MF", pickupDate),
        (freshCode) =>
          tx.insert(manifest).values({
            id: manifestId,
            code: freshCode,
            merchantId: input.merchantId,
            branchId: input.branchId,
            riderId: input.riderId,
            assignmentSource: "merchant_default",
            autoKey,
            pickupDate,
            status: "assigned",
            expectedCount: 1,
            scannedCount: 0,
          }),
      );
      await tx.insert(manifestItem).values({
        id: prefixedId("mfi"),
        manifestId,
        parcelId: input.parcelId,
        awb: input.awb,
      });
      return { manifestId, code };
    });
  } catch (error) {
    // A parallel booking may have won the unique autoKey insert. Attach this
    // parcel to the winner; propagate every unrelated database error unchanged.
    const [winner] = await db
      .select({ id: manifest.id, code: manifest.code })
      .from(manifest)
      .where(and(eq(manifest.autoKey, autoKey), inArray(manifest.status, [...OPEN_MANIFEST_STATUSES])))
      .limit(1);
    if (!winner) throw error;
    return db.transaction((tx) => appendTo(tx, winner.id, winner.code));
  }
}
