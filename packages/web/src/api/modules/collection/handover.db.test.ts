import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, like, or } from "drizzle-orm";
import { db } from "../../database";
import { manifest, manifestItem } from "../../database/schema/collection";
import { branch, user } from "../../database/schema/identity";
import { merchant } from "../../database/schema/merchants";
import { notifyTemplate } from "../../database/schema/notifications";
import { outbox } from "../../database/schema/shared";
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
import { addBookingToAutoManifest } from "./auto-assign";
import { getTemplate } from "../notifications/service";
import {
  colomboToday,
  handoverManifest,
  riderToday,
  scanItem,
} from "./service";

const RUN = Date.now().toString(36).toUpperCase();
const BRANCH_ID = `brn_handover_${RUN}`;
const MERCHANT_ID = `mch_handover_${RUN}`;
const NO_RIDER_MERCHANT_ID = `mch_handover_no_rider_${RUN}`;
const RIDER_ID = `usr_handover_${RUN}`;
const RIDER_PHONE = `+9477${Date.now().toString().slice(-7)}`;

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
const batchIds: string[] = [];
let hadPickupTemplate = false;

beforeAll(async () => {
  await db.insert(branch).values({
    id: BRANCH_ID,
    code: `HH${RUN.slice(-8)}`,
    name: `[handover test] ${RUN}`,
    address: "Disposable handover test branch",
    lat: 0,
    lng: 0,
    type: "branch",
  });
  await db.insert(user).values({
    id: RIDER_ID,
    branchId: BRANCH_ID,
    role: "rider",
    roles: JSON.stringify(["rider"]),
    name: "Handover test rider",
    phone: RIDER_PHONE,
    status: "active",
  });
  await seedMerchant({
    id: MERCHANT_ID,
    branchId: BRANCH_ID,
    pickupRiderId: RIDER_ID,
    name: `[handover test] ${RUN}`,
    address: "Disposable handover integration fixture",
    contactName: "Test Merchant",
    contactPhone: "+94700000000",
    codEnabled: true,
    podPolicy: "signature",
  });
  await seedMerchant({
    id: NO_RIDER_MERCHANT_ID,
    branchId: BRANCH_ID,
    pickupRiderId: null,
    name: `[handover test no rider] ${RUN}`,
    address: "Disposable handover integration fixture",
    contactName: "Test Merchant",
    contactPhone: "+94700000001",
    codEnabled: true,
    podPolicy: "signature",
  });
  const [existingTemplate] = await db
    .select({ key: notifyTemplate.key })
    .from(notifyTemplate)
    .where(eq(notifyTemplate.key, "pickup.rider_parcel_assigned"));
  hadPickupTemplate = Boolean(existingTemplate);
});

afterAll(async () => {
  if (manifestId) {
    await db.delete(manifestItem).where(eq(manifestItem.manifestId, manifestId));
    await db.delete(manifest).where(eq(manifest.id, manifestId));
  }
  if (parcelIds.length) {
    await db.delete(outbox).where(or(...parcelIds.map((id) => like(outbox.payloadJson, `%${id}%`))));
    await db.delete(parcelEvent).where(inArray(parcelEvent.parcelId, parcelIds));
    await db.delete(parcel).where(inArray(parcel.id, parcelIds));
  }
  if (batchIds.length) {
    await db.delete(awbBatchLabel).where(inArray(awbBatchLabel.batchId, batchIds));
    await db.delete(awbBatchSeries).where(inArray(awbBatchSeries.batchId, batchIds));
    await db.delete(awbBatch).where(inArray(awbBatch.id, batchIds));
  }
  if (!hadPickupTemplate) {
    await db.delete(notifyTemplate).where(eq(notifyTemplate.key, "pickup.rider_parcel_assigned"));
  }
  await db.delete(merchant).where(inArray(merchant.id, [MERCHANT_ID, NO_RIDER_MERCHANT_ID]));
  await db.delete(user).where(eq(user.id, RIDER_ID));
  await db.delete(branch).where(eq(branch.id, BRANCH_ID));
});

describe("merchant pickup custody handover", () => {
  test("a rider scan records presence only; custody moves at handover for scanned AWBs only", async () => {
    const [batch] = await createAwbBatches(1, adminActor);
    if (!batch) throw new Error("Could not create the test AWB sticker batch.");
    batchIds.push(batch.id);
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

    const riderPickups = await riderToday(riderActor, colomboToday());
    expect(riderPickups.manifests).toHaveLength(1);
    const pickup = riderPickups.manifests[0]!;
    const assignedManifestId = pickup.id;
    manifestId = assignedManifestId;
    expect(pickup.status).toBe("assigned");
    expect(pickup.assignmentSource).toBe("merchant_default");
    expect(pickup.expectedCount).toBe(2);
    expect(pickup.scannedCount).toBe(0);

    const notificationRows = await db
      .select({ payloadJson: outbox.payloadJson })
      .from(outbox)
      .where(eq(outbox.topic, "notify.dispatch"));
    const alerts = notificationRows
      .map((entry) => JSON.parse(entry.payloadJson) as {
        templateKey: string;
        toPhone: string;
        toUserId: string;
        parcelId: string;
        awb: string;
        merchantId: string;
        vars: Record<string, unknown>;
      })
      .filter((entry) => entry.parcelId === first.parcel.id || entry.parcelId === second.parcel.id);
    expect(alerts).toHaveLength(2);
    const firstAlert = alerts.find((entry) => entry.parcelId === first.parcel.id)!;
    expect(firstAlert).toMatchObject({
      templateKey: "pickup.rider_parcel_assigned",
      toPhone: RIDER_PHONE,
      toUserId: RIDER_ID,
      parcelId: first.parcel.id,
      awb: first.parcel.awb,
      merchantId: MERCHANT_ID,
    });
    expect(firstAlert.vars).toMatchObject({
      merchantName: `[handover test] ${RUN}`,
      awb: first.parcel.awb,
      manifestCode: pickup.code,
      pickupDate: colomboToday(),
    });
    expect(await getTemplate("pickup.rider_parcel_assigned")).toMatchObject({
      key: "pickup.rider_parcel_assigned",
      audience: "rider",
      active: true,
    });

    const duplicateAssignment = await addBookingToAutoManifest({
      merchantId: MERCHANT_ID,
      merchantName: `[handover test] ${RUN}`,
      branchId: BRANCH_ID,
      riderId: RIDER_ID,
      parcelId: first.parcel.id,
      awb: first.parcel.awb,
    });
    expect(duplicateAssignment.added).toBe(false);

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

  test("a merchant without a preferred Rider receives no Rider pickup alert", async () => {
    const [batch] = await createAwbBatches(1, adminActor);
    if (!batch) throw new Error("Could not create the no-Rider test AWB sticker batch.");
    batchIds.push(batch.id);
    await assignAwbBatch(batch.id, "merchant", NO_RIDER_MERCHANT_ID, adminActor);

    const booked = await createParcel(
      {
        merchantId: NO_RIDER_MERCHANT_ID,
        branchId: BRANCH_ID,
        awb: batch.awbStart,
        weightGrams: 500,
        declaredValueCents: 150_000,
        codAmountCents: 0,
        originAddress: "Test merchant pickup point",
        consigneeName: "Test recipient",
        consigneePhone: "+94701112233",
        destAddress: "Test delivery address",
      },
      { ...merchantActor, merchantId: NO_RIDER_MERCHANT_ID },
    );
    parcelIds.push(booked.parcel.id);
    const notificationRows = await db
      .select({ payloadJson: outbox.payloadJson })
      .from(outbox)
      .where(eq(outbox.topic, "notify.dispatch"));
    const alertsForBooking = notificationRows
      .map((entry) => JSON.parse(entry.payloadJson) as { parcelId: string })
      .filter((entry) => entry.parcelId === booked.parcel.id);
    expect(alertsForBooking).toHaveLength(0);
  });
});
