import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, like, or } from "drizzle-orm";
import { db } from "../../database";
import { branch, user } from "../../database/schema/identity";
import { outbox } from "../../database/schema/shared";
import { parcel, parcelEvent } from "../../database/schema/parcels";
import { deliveryAttempt, deliveryPod, runsheet, runsheetItem } from "../../database/schema/delivery";
import { freightCharge, freightEntry, freightReconciliation } from "../../database/schema/freight";
import { rateBand, rateCard, rateCardVersion, rateSlab, rateSurcharge } from "../../database/schema/merchants";
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
import { createRateCard, newDraft, publishDraft, quoteForCounter, saveDraft } from "../merchants/rate-cards";
import { NATEX_STANDARD_CARD_NAME, natexStandardTariffDocument } from "../merchants/standard-tariff";
import { entriesForCharge, pageCounterBookings, pageFreightCharges, reconcileFreightEntry, refundFreight } from "./ledger";

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
let testRateCardId: string | null = null;
let testRateCardVersionId: string | null = null;
let standardRateCardId: string | null = null;

const bookingInput = (requestId: string, payer: "sender" | "recipient") => ({
  requestId,
  branchId: branchId!,
  rateCardVersionId: testRateCardVersionId!,
  weightGrams: 750,
  declaredValueCents: null,
  description: "Books and stationery",
  senderName: "Counter Sender Test",
  senderPhone: "+94770000001",
  senderAddress: "10 Test Road, Colombo",
  payer,
  paymentMethod: payer === "sender" ? "cash" as const : undefined,
  consigneeName: "Counter Recipient Test",
  consigneePhone: "+94770000002",
  destAddress: "22 Sample Lane, Colombo, Western Province",
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
    address: "1 Test Street, Colombo, Western Province",
    latE6: 6_927_100,
    lngE6: 79_861_200,
    type: "branch",
  });
  branchId = createdBranch!.id;
  OPS.branchId = branchId;
  FINANCE.branchId = branchId;
  const tariff = await createRateCard({ code: `T${RUN.slice(-8)}`, name: "Freight integration tariff", placeholder: false, actorName: OPS.name });
  testRateCardId = tariff.card.id;
  testRateCardVersionId = tariff.versionId;
  await saveDraft(tariff.versionId, {
    volumetricDivisor: 5000,
    roundingGrams: 500,
    note: "Disposable integration fixture",
    bands: [
      { band: "local", label: "Local", extraPerKgCents: 0 },
      { band: "outstation", label: "Outstation", extraPerKgCents: 0 },
    ],
    slabs: [
      { band: "local", maxGrams: 1000, priceCents: 4_250 },
      { band: "local", maxGrams: 2000, priceCents: 5_250 },
      { band: "outstation", maxGrams: 1000, priceCents: 5_250 },
      { band: "outstation", maxGrams: 2000, priceCents: 6_250 },
    ],
    surcharges: [],
  }, OPS.name);
  await publishDraft(tariff.versionId, OPS.name);
  await db.update(branch).set({ counterRateCardId: tariff.card.id }).where(eq(branch.id, branchId));
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
  for (const cardId of [testRateCardId, standardRateCardId]) {
    if (!cardId) continue;
    const versions = await db.select({ id: rateCardVersion.id }).from(rateCardVersion).where(eq(rateCardVersion.rateCardId, cardId));
    const versionIds = versions.map((row) => row.id);
    if (versionIds.length) {
      await db.delete(rateBand).where(inArray(rateBand.versionId, versionIds));
      await db.delete(rateSlab).where(inArray(rateSlab.versionId, versionIds));
      await db.delete(rateSurcharge).where(inArray(rateSurcharge.versionId, versionIds));
      await db.delete(rateCardVersion).where(inArray(rateCardVersion.id, versionIds));
    }
    await db.delete(rateCard).where(eq(rateCard.id, cardId));
  }
});

describe("retail customer freight remains separate from COD", () => {
  test("sender-paid counter booking creates a receipt and immutable freight collection", async () => {
    const outstationQuote = await quoteForCounter(branchId!, {
      weightGrams: 750,
      destinationAddress: "22 Sample Lane, Kandy, Central Province",
    });
    expect(outstationQuote).toMatchObject({ band: "outstation", originDistrict: "Colombo", destinationDistrict: "Kandy", totalCents: 5_250 });
    const quotedVersionId = testRateCardVersionId!;
    const nextDraft = await newDraft(testRateCardId!, OPS.name);
    const nextVersionId = nextDraft.version.id;
    await saveDraft(nextVersionId, {
      volumetricDivisor: nextDraft.version.volumetricDivisor,
      roundingGrams: nextDraft.version.roundingGrams,
      note: "Republished integration tariff",
      bands: nextDraft.bands,
      slabs: nextDraft.slabs,
      surcharges: nextDraft.surcharges,
    }, OPS.name);
    await publishDraft(nextVersionId, OPS.name);
    await expect(createRetailCounterBooking({
      ...bookingInput(`freight-stale-quote-${RUN}`, "sender"),
      rateCardVersionId: quotedVersionId,
    }, OPS)).rejects.toThrow("changed after the price was quoted");
    testRateCardVersionId = nextVersionId;
    const booked = await createRetailCounterBooking(bookingInput(`freight-sender-${RUN}`, "sender"), OPS);

    expect(booked.parcel.merchantId).toBeNull();
    expect(booked.parcel.codAmountCents).toBe(0);
    expect(booked.parcel.description).toBe("Books and stationery");
    expect(booked.parcel.declaredValueCents).toBeNull();
    expect(booked.parcel.status).toBe("AtOriginHub");
    expect(booked.freightCharge.payer).toBe("sender");
    expect(booked.freightCharge.amountCents).toBe(4_250);
    expect(booked.freightCharge.pricingBasis).toBe("rate_card");
    const savedPricing = JSON.parse(booked.freightCharge.pricingSnapshotJson!) as { band: string; originDistrict: string; destinationDistrict: string; totalCents: number; version: { id: string } };
    expect(savedPricing).toMatchObject({ band: "local", originDistrict: "Colombo", destinationDistrict: "Colombo", totalCents: 4_250, version: { id: testRateCardVersionId } });
    expect(booked.paidReceipt?.entryType).toBe("collection");
    expect(booked.paidReceipt?.paymentMethod).toBe("cash");
    expect(booked.paidReceipt?.code.startsWith("RCP")).toBe(true);
    expect(await collectionForParcel(booked.parcel.id)).toBeNull();
    expect(await bookingSmsForAwb(booked.parcel.awb)).toHaveLength(0);
    const byReceiverPhone = await pageCounterBookings(OPS, { search: "+94770000002", page: 1, pageSize: 20 });
    expect(byReceiverPhone.rows[0]).toMatchObject({
      parcel: { id: booked.parcel.id, description: "Books and stationery", declaredValueCents: null },
      freightCharge: { id: booked.freightCharge.id },
      paidReceipt: { id: booked.paidReceipt?.id },
    });
    const bySender = await pageCounterBookings(OPS, { search: "Counter Sender Test", page: 1, pageSize: 20 });
    expect(bySender.rows.some((row) => row.parcel.id === booked.parcel.id)).toBe(true);
    const otherBranch = await pageCounterBookings({ ...OPS, branchId: `${branchId}-other` }, { page: 1, pageSize: 20 });
    expect(otherBranch.rows).toHaveLength(0);
    const chargeRegister = await pageFreightCharges(FINANCE, { page: 1, pageSize: 100 });
    expect(chargeRegister.rows.find((row) => row.charge.id === booked.freightCharge.id)?.dueCents).toBe(0);

    const repeated = await createRetailCounterBooking(bookingInput(`freight-sender-${RUN}`, "sender"), OPS);
    expect(repeated.parcel.id).toBe(booked.parcel.id);
    expect(repeated.paidReceipt?.id).toBe(booked.paidReceipt?.id);
    expect((await entriesForCharge(booked.freightCharge.id)).filter((entry) => entry.entryType === "collection")).toHaveLength(1);
    expect(await bookingSmsForAwb(booked.parcel.awb)).toHaveLength(0);
  });

  test("Counter quotes and bookings reject actual or volumetric weight above 30 kg", async () => {
    await expect(quoteForCounter(branchId!, {
      weightGrams: 30_001,
      destinationAddress: "22 Sample Lane, Kandy, Central Province",
    })).rejects.toThrow("30 kg");
    await expect(quoteForCounter(branchId!, {
      weightGrams: 1000,
      lengthCm: 101,
      widthCm: 50,
      heightCm: 30,
      destinationAddress: "22 Sample Lane, Kandy, Central Province",
    })).rejects.toThrow("30 kg");
    await expect(createRetailCounterBooking({
      ...bookingInput(`freight-overweight-${RUN}`, "sender"),
      weightGrams: 30_001,
    }, OPS)).rejects.toThrow("30 kg");
  });

  test("approved standard card publishes the progressive schedule and quotes both bands", async () => {
    const created = await createRateCard({
      code: `NST${RUN.slice(-8)}`,
      name: NATEX_STANDARD_CARD_NAME,
      placeholder: false,
      actorName: OPS.name,
    });
    standardRateCardId = created.card.id;
    const document = natexStandardTariffDocument();
    const saved = await saveDraft(created.versionId, document, OPS.name);
    expect(saved.problems).toEqual([]);
    await publishDraft(created.versionId, OPS.name);
    await db.update(branch).set({ counterRateCardId: created.card.id }).where(eq(branch.id, branchId!));

    try {
      const local = await quoteForCounter(branchId!, {
        weightGrams: 7000,
        destinationAddress: "22 Sample Lane, Colombo, Western Province",
      });
      const outstation = await quoteForCounter(branchId!, {
        weightGrams: 7000,
        destinationAddress: "22 Sample Lane, Kandy, Central Province",
      });
      const atLimit = await quoteForCounter(branchId!, {
        weightGrams: 30_000,
        destinationAddress: "22 Sample Lane, Kandy, Central Province",
      });
      expect(local).toMatchObject({ band: "local", totalCents: 150_000 });
      expect(outstation).toMatchObject({ band: "outstation", totalCents: 150_000 });
      expect(atLimit.totalCents).toBe(455_000);
    } finally {
      await db.update(branch).set({ counterRateCardId: testRateCardId }).where(eq(branch.id, branchId!));
    }
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
    const counterHistory = await pageCounterBookings(OPS, { search: booked.parcel.awb, page: 1, pageSize: 10 });
    expect(counterHistory.rows).toHaveLength(1);
    expect(counterHistory.rows[0]?.paidReceipt?.code).toBe(delivered.freightReceiptCode ?? undefined);
    expect(counterHistory.rows[0]?.dueCents).toBe(0);
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
