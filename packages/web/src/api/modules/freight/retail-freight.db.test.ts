import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, like, or } from "drizzle-orm";
import { db } from "../../database";
import { branch, user } from "../../database/schema/identity";
import { outbox } from "../../database/schema/shared";
import { parcel, parcelEvent } from "../../database/schema/parcels";
import { deliveryAttempt, deliveryPod, runsheet, runsheetItem } from "../../database/schema/delivery";
import { freightCharge, freightEntry, freightReconciliation } from "../../database/schema/freight";
import type { Principal } from "../../shared/auth";
import { createBranch, createUser } from "../identity/service";
import { createRetailCounterBooking, getParcelById, transitionParcel } from "../parcels/service";
import {
  addToRunsheet,
  closeRunsheet,
  createRunsheet,
  dispatchRunsheet,
  recordDelivery,
} from "../delivery/service";
import { collectionForParcel } from "../cod/service";
import { entriesForCharge, pageFreightCharges, reconcileFreightEntry, refundFreight } from "./ledger";

const RUN = Date.now().toString(36).toUpperCase();
const BRANCH_CODE = `F${RUN.slice(-8)}`;
const OPS: Principal = {
  userId: `usr_frt_ops_${RUN}`,
  name: "Freight integration ops",
  role: "ops",
  roles: ["ops"],
  branchId: "",
};
const FINANCE: Principal = {
  userId: `usr_frt_fin_${RUN}`,
  name: "Freight integration finance",
  role: "finance",
  roles: ["finance"],
  branchId: "",
};
let branchId: string | null = null;
let riderId: string | null = null;

const bookingInput = (requestId: string, payer: "sender" | "recipient") => ({
  requestId,
  branchId: branchId!,
  weightGrams: 750,
  declaredValueCents: 15_000,
  senderName: "Counter Sender Test",
  senderPhone: "+94770000001",
  senderAddress: "10 Test Road, Colombo",
  payer,
  freightAmountCents: 4_250,
  paymentMethod: payer === "sender" ? "cash" as const : undefined,
  consigneeName: "Counter Recipient Test",
  consigneePhone: "+94770000002",
  destAddress: "22 Sample Lane, Colombo 03",
});

async function bookingSmsForAwb(awb: string) {
  const rows = await db
    .select({ payloadJson: outbox.payloadJson })
    .from(outbox)
    .where(eq(outbox.topic, "sms.send"));
  return rows
    .map((entry) => JSON.parse(entry.payloadJson) as {
      to: string;
      body: string;
      purpose: string;
      parcelId: string;
      awb: string;
    })
    .filter((entry) => entry.awb === awb);
}

beforeAll(async () => {
  const createdBranch = await createBranch({
    code: BRANCH_CODE,
    name: "Freight integration test branch",
    address: "1 Test Street, Colombo",
    latE6: 6_927_100,
    lngE6: 79_861_200,
    type: "branch",
  });
  branchId = createdBranch!.id;
  OPS.branchId = branchId;
  FINANCE.branchId = branchId;
  const createdRider = await createUser({
    branchId,
    role: "rider",
    name: "Freight integration test Rider",
    phone: `+947${Date.now().toString().slice(-8)}`,
  });
  riderId = createdRider.id;
});

afterAll(async () => {
  if (branchId) {
    const parcelIds = (await db.select({ id: parcel.id }).from(parcel).where(eq(parcel.branchId, branchId))).map((row) => row.id);
    const allRuns = (await db.select({ id: runsheet.id }).from(runsheet).where(eq(runsheet.branchId, branchId))).map((row) => row.id);
    if (allRuns.length) await db.delete(runsheetItem).where(inArray(runsheetItem.runsheetId, allRuns));
    if (parcelIds.length) {
      await db.delete(outbox).where(or(...parcelIds.map((id) => like(outbox.payloadJson, `%${id}%`))));
      await db.delete(freightReconciliation).where(inArray(freightReconciliation.branchId, [branchId]));
      await db.delete(freightEntry).where(inArray(freightEntry.parcelId, parcelIds));
      await db.delete(freightCharge).where(inArray(freightCharge.parcelId, parcelIds));
      await db.delete(deliveryAttempt).where(inArray(deliveryAttempt.parcelId, parcelIds));
      await db.delete(deliveryPod).where(inArray(deliveryPod.parcelId, parcelIds));
      await db.delete(parcelEvent).where(inArray(parcelEvent.parcelId, parcelIds));
      await db.delete(parcel).where(inArray(parcel.id, parcelIds));
    }
    if (allRuns.length) await db.delete(runsheet).where(inArray(runsheet.id, allRuns));
    if (riderId) await db.delete(user).where(eq(user.id, riderId));
    await db.delete(branch).where(eq(branch.id, branchId));
  }
});

describe("retail customer freight remains separate from COD", () => {
  test("sender-paid counter booking creates a receipt and immutable freight collection", async () => {
    const booked = await createRetailCounterBooking(bookingInput(`freight-sender-${RUN}`, "sender"), OPS);

    expect(booked.parcel.merchantId).toBeNull();
    expect(booked.parcel.codAmountCents).toBe(0);
    expect(booked.parcel.status).toBe("AtOriginHub");
    expect(booked.freightCharge.payer).toBe("sender");
    expect(booked.freightCharge.amountCents).toBe(4_250);
    expect(booked.paidReceipt?.entryType).toBe("collection");
    expect(booked.paidReceipt?.paymentMethod).toBe("cash");
    expect(booked.paidReceipt?.code.startsWith("RCP")).toBe(true);
    expect(await collectionForParcel(booked.parcel.id)).toBeNull();
    const bookingSms = await bookingSmsForAwb(booked.parcel.awb);
    expect(bookingSms).toHaveLength(1);
    expect(bookingSms[0]).toMatchObject({
      to: "+94770000002",
      purpose: "notification",
      parcelId: booked.parcel.id,
      awb: booked.parcel.awb,
    });
    expect(bookingSms[0]!.body).toContain(`AWB/Tracking: ${booked.parcel.awb}`);
    expect(bookingSms[0]!.body).toContain(`/track/${booked.parcel.awb}`);
    expect(bookingSms[0]!.body.length).toBeLessThanOrEqual(159);
    const chargeRegister = await pageFreightCharges(FINANCE, { page: 1, pageSize: 100 });
    expect(chargeRegister.rows.find((row) => row.charge.id === booked.freightCharge.id)?.dueCents).toBe(0);

    const repeated = await createRetailCounterBooking(bookingInput(`freight-sender-${RUN}`, "sender"), OPS);
    expect(repeated.parcel.id).toBe(booked.parcel.id);
    expect(repeated.paidReceipt?.id).toBe(booked.paidReceipt?.id);
    expect((await entriesForCharge(booked.freightCharge.id)).filter((entry) => entry.entryType === "collection")).toHaveLength(1);
    expect(await bookingSmsForAwb(booked.parcel.awb)).toHaveLength(1);
  });

  test("Finance reconciles and refunds the original sender collection without deleting it", async () => {
    const booked = await createRetailCounterBooking(bookingInput(`freight-refund-${RUN}`, "sender"), OPS);
    const original = booked.paidReceipt!;

    const reconciled = await reconcileFreightEntry({ entryId: original.id, reference: `BANK-${RUN}` }, FINANCE);
    expect(reconciled.reconciliation.reference).toBe(`BANK-${RUN}`);
    await expect(reconcileFreightEntry({ entryId: original.id, reference: "DUPLICATE" }, FINANCE)).rejects.toThrow();

    const reversal = await refundFreight({
      chargeId: booked.freightCharge.id,
      amountCents: 1_250,
      paymentMethod: "bank_transfer",
      externalReference: `REF-${RUN}`,
      reason: "Customer cancelled before transport.",
    }, FINANCE);
    expect(reversal.entry.entryType).toBe("refund");
    expect(reversal.entry.amountCents).toBe(-1_250);
    expect(reversal.entry.reversalOfId).toBe(original.id);
    expect(reversal.paidCents).toBe(3_000);
    const chargeRegister = await pageFreightCharges(FINANCE, { page: 1, pageSize: 100 });
    expect(chargeRegister.rows.find((row) => row.charge.id === booked.freightCharge.id)?.dueCents).toBe(1_250);
    expect((await entriesForCharge(booked.freightCharge.id)).map((entry) => entry.entryType).sort()).toEqual(["collection", "refund"]);
  });

  test("recipient-paid freight is collected by the assigned Rider before Delivered and never enters COD", async () => {
    const booked = await createRetailCounterBooking(bookingInput(`freight-recipient-${RUN}`, "recipient"), OPS);
    expect(booked.paidReceipt).toBeNull();
    expect(await entriesForCharge(booked.freightCharge.id)).toHaveLength(0);
    const openCharges = await pageFreightCharges(FINANCE, { page: 1, pageSize: 100, payer: "recipient" });
    expect(openCharges.rows.find((row) => row.charge.id === booked.freightCharge.id)?.dueCents).toBe(4_250);

    // Model the actual hub/linehaul route, retaining parcel-event custody history.
    await transitionParcel({ awbOrId: booked.parcel.awb, to: "Bagged" }, OPS);
    await transitionParcel({ awbOrId: booked.parcel.awb, to: "InTransit" }, OPS, { tripId: `test-trip-${RUN}` });
    await transitionParcel({ awbOrId: booked.parcel.awb, to: "AtDestHub" }, OPS);

    const run = await createRunsheet({ riderId: riderId! }, OPS);
    const added = await addToRunsheet({ runsheetId: run.id, awbs: [booked.parcel.awb] }, OPS);
    expect(added.added).toBe(1);
    const dispatched = await dispatchRunsheet({ runsheetId: run.id }, OPS);
    expect(dispatched.movedOut).toContain(booked.parcel.awb);

    const baseDelivery = {
      awb: booked.parcel.awb,
      receivedByName: "Recipient Test",
      method: "signature" as const,
      signatureData: "integration-test-signature",
      codCollectedCents: 0,
    };
    const rider: Principal = { ...OPS, role: "rider", roles: ["rider"], userId: riderId!, name: "Freight integration test Rider" };
    await expect(recordDelivery({
      ...baseDelivery,
      freightCollectedCents: 4_249,
      freightPaymentMethod: "cash",
      clientId: `freight-wrong-${RUN}`,
    }, rider)).rejects.toThrow();

    expect((await getParcelById(booked.parcel.id))?.status).toBe("OutForDelivery");
    expect(await entriesForCharge(booked.freightCharge.id)).toHaveLength(0);
    expect(await collectionForParcel(booked.parcel.id)).toBeNull();

    const delivered = await recordDelivery({
      ...baseDelivery,
      freightCollectedCents: 4_250,
      freightPaymentMethod: "bank_transfer",
      freightExternalReference: `TRX-${RUN}`,
      clientId: `freight-good-${RUN}`,
    }, rider);
    expect(delivered.parcel.status).toBe("Delivered");
    expect(delivered.codCollectedCents).toBe(0);
    expect(delivered.freightCollectedCents).toBe(4_250);
    expect(delivered.freightReceiptCode?.startsWith("RCP")).toBe(true);
    expect(await collectionForParcel(booked.parcel.id)).toBeNull();
    const entries = await entriesForCharge(booked.freightCharge.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.paymentMethod).toBe("bank_transfer");
    expect(entries[0]?.externalReference).toBe(`TRX-${RUN}`);
    const replay = await recordDelivery({
      ...baseDelivery,
      freightCollectedCents: 4_250,
      freightPaymentMethod: "bank_transfer",
      freightExternalReference: `TRX-${RUN}`,
      clientId: `freight-good-${RUN}`,
    }, rider);
    expect(replay.deduped).toBe(true);
    expect(replay.freightReceiptCode).toBe(delivered.freightReceiptCode);
    expect(await entriesForCharge(booked.freightCharge.id)).toHaveLength(1);
    const settledCharges = await pageFreightCharges(FINANCE, { page: 1, pageSize: 100, payer: "recipient" });
    expect(settledCharges.rows.find((row) => row.charge.id === booked.freightCharge.id)?.dueCents).toBe(0);

    const closed = await closeRunsheet({ runsheetId: run.id }, OPS);
    expect(closed.cash).toEqual({ expectedCents: 0, collectedCents: 0, varianceCents: 0 });
    expect(closed.freightCash).toEqual({ expectedCents: 4_250, collectedCents: 4_250, varianceCents: 0 });
  });
});
