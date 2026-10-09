import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import { manifest, manifestItem } from "../../database/schema/collection";
import { merchant } from "../../database/schema/merchants";
import {
  awbBatch,
  awbBatchLabel,
  awbBatchSeries,
  parcel,
  parcelEvent,
} from "../../database/schema/parcels";
import type { Principal } from "../../shared/auth";
import { seedMerchant } from "../merchants/service";
import { createParcel, getParcelByAwb } from "../parcels/service";
import { assignAwbBatch, createAwbBatches } from "../parcels/awb-batches";
import { createAwbSeries } from "../parcels/awb-series";
import {
  colomboToday,
  createManifest,
  handoverManifest,
  scanItem,
} from "./service";

const RUN = Date.now().toString(36).toUpperCase();
const BRANCH_ID = `brn_handover_${RUN}`;
const MERCHANT_ID = `mch_handover_${RUN}`;
const RIDER_ID = `usr_handover_${RUN}`;

const merchantActor: Principal = {
  userId: `usr_merchant_${RUN}`,
  name: "Handover test merchant",
  role: "merchant",
  roles: ["merchant"],
  branchId: BRANCH_ID,
  merchantId: MERCHANT_ID,
  deviceId: null,
};
const opsActor: Principal = {
  userId: `usr_ops_${RUN}`,
  name: "Handover test ops",
  role: "ops",
  roles: ["ops"],
  branchId: BRANCH_ID,
  merchantId: null,
  deviceId: null,
};
const riderActor: Principal = {
  userId: RIDER_ID,
  name: "Handover test rider",
  role: "rider",
  roles: ["rider"],
  branchId: BRANCH_ID,
  merchantId: null,
  deviceId: null,
};
const adminActor: Principal = {
  userId: `usr_admin_${RUN}`,
  name: "Handover test admin",
  role: "admin",
  roles: ["admin"],
  branchId: BRANCH_ID,
  merchantId: null,
  deviceId: null,
};

const parcelIds: string[] = [];
let manifestId: string | null = null;
let batchId: string | null = null;

beforeAll(async () => {
  await seedMerchant({
    id: MERCHANT_ID,
    branchId: BRANCH_ID,
    name: `[handover test] ${RUN}`,
    address: "Disposable handover integration fixture",
    contactName: "Test Merchant",
    contactPhone: "+94700000000",
    codEnabled: true,
    podPolicy: "signature",
  });
});

afterAll(async () => {
  if (manifestId) {
    await db.delete(manifestItem).where(eq(manifestItem.manifestId, manifestId));
    await db.delete(manifest).where(eq(manifest.id, manifestId));
  }
  if (parcelIds.length) {
    await db.delete(parcelEvent).where(inArray(parcelEvent.parcelId, parcelIds));
    await db.delete(parcel).where(inArray(parcel.id, parcelIds));
  }
  if (batchId) {
    await db.delete(awbBatchLabel).where(eq(awbBatchLabel.batchId, batchId));
    await db.delete(awbBatchSeries).where(eq(awbBatchSeries.batchId, batchId));
    await db.delete(awbBatch).where(eq(awbBatch.id, batchId));
  }
  await db.delete(merchant).where(eq(merchant.id, MERCHANT_ID));
});

describe("merchant pickup custody handover", () => {
  test("a rider scan records presence only; custody moves at handover for scanned AWBs only", async () => {
    const [batch] = await createAwbBatches(1, adminActor);
    if (!batch) throw new Error("Could not create the test AWB sticker batch.");
    batchId = batch.id;
    await assignAwbBatch(batch.id, "merchant", MERCHANT_ID, adminActor);
    const secondAwb = createAwbSeries(batch.awbStart.slice(2), 2)[1]!;

    const input = {
      merchantId: MERCHANT_ID,
      branchId: BRANCH_ID,
      weightGrams: 500,
      declaredValueCents: 150_000,
      codAmountCents: 0,
      originAddress: "Test merchant pickup point",
      consigneeName: "Test recipient",
      consigneePhone: "+94701112233",
      destAddress: "Test delivery address",
    };
    const first = await createParcel({ ...input, awb: batch.awbStart }, merchantActor);
    const second = await createParcel({ ...input, awb: secondAwb }, merchantActor);
    parcelIds.push(first.parcel.id, second.parcel.id);
    expect(first.parcel.status).toBe("Booked");
    expect(second.parcel.status).toBe("Booked");

    const pickup = await createManifest(
      {
        merchantId: MERCHANT_ID,
        riderId: RIDER_ID,
        pickupDate: colomboToday(),
        awbs: [first.parcel.awb, second.parcel.awb],
      },
      opsActor,
    );
    const assignedManifestId = pickup.manifest.id;
    manifestId = assignedManifestId;
    expect(pickup.manifest.status).toBe("assigned");

    await expect(
      scanItem({ manifestId: assignedManifestId, awb: first.parcel.awb }, opsActor),
    ).rejects.toMatchObject({ status: 403 });

    const scanned = await scanItem(
      { manifestId: assignedManifestId, awb: first.parcel.awb },
      riderActor,
    );
    expect(scanned.item.scannedAt).toBeInstanceOf(Date);
    expect((await getParcelByAwb(first.parcel.awb))?.status).toBe("Booked");
    expect((await getParcelByAwb(second.parcel.awb))?.status).toBe("Booked");

    await expect(
      handoverManifest(
        { manifestId: assignedManifestId, handoverByName: "Ops bypass attempt" },
        opsActor,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect((await getParcelByAwb(first.parcel.awb))?.status).toBe("Booked");

    const handover = await handoverManifest(
      { manifestId: assignedManifestId, handoverByName: "Merchant staff test" },
      riderActor,
    );
    expect(handover.manifest.status).toBe("handed_over");
    expect(handover.movedAwbs).toEqual([first.parcel.awb]);
    expect(handover.missingAwbs).toEqual([second.parcel.awb]);
    expect((await getParcelByAwb(first.parcel.awb))?.status).toBe("PickedUp");
    expect((await getParcelByAwb(second.parcel.awb))?.status).toBe("Booked");
  });
});
