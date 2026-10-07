import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "../../database";
import { branch } from "../../database/schema/identity";
import { merchant } from "../../database/schema/merchants";
import { awbBatch, awbBatchLabel, parcel } from "../../database/schema/parcels";
import { prefixedId } from "../../shared/ulid";
import type { Principal } from "../../shared/auth";
import { assignAwbBatch, createAwbBatches, listAwbBatches, nextUnusedAwbForBooking } from "./awb-batches";
import { createAwbSeries } from "./awb-series";

/**
 * Integration coverage for planned batch generation and assignment.
 * Run against a disposable database after applying the schema:
 * DATABASE_URL=file:/tmp/natex-awb-batches.db NODE_ENV=test bun test src/api/modules/parcels/awb-batches.db.test.ts
 */
setDefaultTimeout(120_000);

const RUN = Date.now().toString(36).toUpperCase();
const BRANCH_ID = `brn_awb_${RUN}`;
const HUB_ID = `hub_awb_${RUN}`;
const MERCHANT_IDS = [prefixedId("mch"), prefixedId("mch"), prefixedId("mch")];
const BRANCH_CODE = `AB${RUN.slice(-8)}`;
const HUB_CODE = `AH${RUN.slice(-8)}`;
const ACTOR: Principal = {
  userId: `usr_awb_test_${RUN}`,
  name: "AWB batch integration test",
  role: "admin",
  roles: ["admin"],
  branchId: BRANCH_ID,
  merchantId: null,
  deviceId: null,
};
const CREATED_BATCH_IDS: string[] = [];
const USED_PARCEL_IDS: string[] = [];

beforeAll(async () => {
  await db.insert(branch).values([
    { id: BRANCH_ID, code: BRANCH_CODE, name: "[test] AWB branch", address: "Test branch address", lat: 0, lng: 0, type: "branch" },
    { id: HUB_ID, code: HUB_CODE, name: "[test] AWB hub", address: "Test hub address", lat: 0, lng: 0, type: "hub" },
  ]);
  const phoneBase = Date.now().toString().slice(-6);
  await db.insert(merchant).values(MERCHANT_IDS.map((id, index) => ({
    id,
    branchId: index === 2 ? HUB_ID : BRANCH_ID,
    name: `[test] AWB merchant ${index + 1} ${RUN}`,
    address: "Test merchant address",
    contactName: "AWB test owner",
    contactPhone: `+9477${phoneBase}${index}`,
    codEnabled: true,
    podPolicy: "signature",
    status: "active",
  })));
});

afterAll(async () => {
  if (USED_PARCEL_IDS.length) {
    await db.delete(parcel).where(inArray(parcel.id, USED_PARCEL_IDS));
  }
  if (CREATED_BATCH_IDS.length) {
    await db.delete(awbBatchLabel).where(inArray(awbBatchLabel.batchId, CREATED_BATCH_IDS));
    await db.delete(awbBatch).where(inArray(awbBatch.id, CREATED_BATCH_IDS));
  }
  await db.delete(merchant).where(inArray(merchant.id, MERCHANT_IDS));
  await db.delete(branch).where(inArray(branch.id, [BRANCH_ID, HUB_ID]));
});

function reserveOneLabelAsUsed(awb: string, merchantId: string, branchId: string) {
  const id = prefixedId("pcl");
  USED_PARCEL_IDS.push(id);
  return db.insert(parcel).values({
    id,
    awb,
    merchantId,
    branchId,
    status: "Booked",
    weightGrams: 500,
    declaredValueCents: 0,
    codAmountCents: 0,
    originAddress: "Test origin address",
    consigneeName: "AWB test consignee",
    consigneePhone: "+94770000001",
    destAddress: "Test destination address",
  });
}

describe("AWB batch planning and assignment", () => {
  test("generates 10 planned batches, assigns each owner type, and tracks bookings", async () => {
    const generated = await createAwbBatches(10, ACTOR);
    CREATED_BATCH_IDS.push(...generated.map((batch) => batch.id));
    expect(generated).toHaveLength(10);
    expect(generated.every((batch) => batch.labelCount === 1_000 && batch.assignmentStatus === "planned")).toBe(true);
    expect(new Set(generated.map((batch) => batch.batchCode)).size).toBe(10);
    const starts = generated.map((batch) => BigInt(batch.awbStart.slice(2))).sort((a, b) => a < b ? -1 : 1);
    expect(starts.every((start, index) => index === 0 || start > starts[index - 1]! + 999n)).toBe(true);

    expect(await nextUnusedAwbForBooking(MERCHANT_IDS[0]!, BRANCH_ID)).toBeNull();

    const merchantBatch = generated[0]!;
    const branchBatch = generated[1]!;
    const hubBatch = generated[2]!;
    await assignAwbBatch(merchantBatch.id, "merchant", MERCHANT_IDS[0]!, ACTOR);
    await assignAwbBatch(branchBatch.id, "branch", BRANCH_ID, ACTOR);
    await assignAwbBatch(hubBatch.id, "hub", HUB_ID, ACTOR);

    await expect(assignAwbBatch(merchantBatch.id, "hub", HUB_ID, ACTOR)).rejects.toThrow();
    expect(await nextUnusedAwbForBooking(MERCHANT_IDS[0]!, BRANCH_ID)).toBe(merchantBatch.awbStart);
    expect(await nextUnusedAwbForBooking(MERCHANT_IDS[1]!, BRANCH_ID)).toBe(branchBatch.awbStart);
    expect(await nextUnusedAwbForBooking(MERCHANT_IDS[2]!, HUB_ID)).toBe(hubBatch.awbStart);

    await reserveOneLabelAsUsed(merchantBatch.awbStart, MERCHANT_IDS[0]!, BRANCH_ID);
    await reserveOneLabelAsUsed(branchBatch.awbStart, MERCHANT_IDS[1]!, BRANCH_ID);
    await reserveOneLabelAsUsed(hubBatch.awbStart, MERCHANT_IDS[2]!, HUB_ID);

    expect(await nextUnusedAwbForBooking(MERCHANT_IDS[0]!, BRANCH_ID)).toBe(createAwbSeries(merchantBatch.awbStart.slice(2), 2)[1]);
    expect(await nextUnusedAwbForBooking(MERCHANT_IDS[1]!, BRANCH_ID)).toBe(createAwbSeries(branchBatch.awbStart.slice(2), 2)[1]);
    expect(await nextUnusedAwbForBooking(MERCHANT_IDS[2]!, HUB_ID)).toBe(createAwbSeries(hubBatch.awbStart.slice(2), 2)[1]);

    const inventory = await listAwbBatches();
    for (const batch of [merchantBatch, branchBatch, hubBatch]) {
      const row = inventory.find((item) => item.id === batch.id);
      expect(row?.usedCount).toBe(1);
      expect(row?.unusedCount).toBe(999);
      expect(row?.status).toBe("assigned");
    }
    expect(inventory.filter((row) => row.status === "planned" && generated.some((batch) => batch.id === row.id))).toHaveLength(7);
  });
});
