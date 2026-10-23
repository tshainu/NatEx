import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, like, or } from "drizzle-orm";
import { db } from "../../database";
import { branch, merchant } from "../../database/schema";
import { outbox, smsLog } from "../../database/schema/shared";
import { parcel, parcelEvent } from "../../database/schema/parcels";
import type { Principal } from "../../shared/auth";
import { createParcel, type CreateParcelInput } from "./service";

const runId = Date.now().toString(36).toUpperCase();
const branchId = `brn_sms_${runId}`;
const codMerchantId = `mch_sms_cod_${runId}`;
const nonCodMerchantId = `mch_sms_nocod_${runId}`;
const codSender = "+94770000001";
const codReceiver = "+94770000002";
const nonCodSender = "+94770000003";
const nonCodReceiver = "+94770000004";
const merchantIds = [codMerchantId, nonCodMerchantId];
const testPhones = [codSender, codReceiver, nonCodSender, nonCodReceiver];
const actor: Principal = {
  userId: `usr_sms_ops_${runId}`,
  name: "Local SMS policy test",
  role: "ops",
  roles: ["ops"],
  branchId,
  merchantId: null,
  deviceId: null,
};
const input = (merchantId: string, codAmountCents: number, consigneePhone: string): CreateParcelInput => ({
  merchantId,
  branchId,
  weightGrams: 1000,
  declaredValueCents: 0,
  codAmountCents,
  originAddress: "Isolated test address, Jaffna",
  consigneeName: "Local SMS policy test",
  consigneePhone,
  destAddress: "Isolated test destination, Jaffna",
});

beforeAll(async () => {
  const now = new Date();
  await db.insert(branch).values({ id: branchId, code: `SMS${runId}`, name: "Local SMS policy test", address: "Local only", lat: 0, lng: 0, type: "branch", createdAt: now });
  await db.insert(merchant).values([
    { id: codMerchantId, branchId, name: "Local COD merchant", address: "Local only", contactName: "Test sender", contactPhone: codSender, codEnabled: true, podPolicy: "signature", status: "active", createdAt: now },
    { id: nonCodMerchantId, branchId, name: "Local non-COD merchant", address: "Local only", contactName: "Test sender", contactPhone: nonCodSender, codEnabled: false, podPolicy: "signature", status: "active", createdAt: now },
  ]);
});

afterAll(async () => {
  const parcelIds = (await db.select({ id: parcel.id }).from(parcel).where(eq(parcel.branchId, branchId))).map((row) => row.id);
  if (parcelIds.length) {
    await db.delete(outbox).where(or(...parcelIds.map((id) => like(outbox.payloadJson, `%${id}%`))));
    await db.delete(parcelEvent).where(inArray(parcelEvent.parcelId, parcelIds));
    await db.delete(parcel).where(inArray(parcel.id, parcelIds));
  }
  await db.delete(smsLog).where(inArray(smsLog.toPhone, testPhones));
  await db.delete(merchant).where(inArray(merchant.id, merchantIds));
  await db.delete(branch).where(eq(branch.id, branchId));
});

describe("merchant parcel booking SMS policy", () => {
  test("does not queue or send booking SMS for either COD or non-COD shipments", async () => {
    const cod = await createParcel(input(codMerchantId, 25_000, codReceiver), actor);
    const nonCod = await createParcel(input(nonCodMerchantId, 0, nonCodReceiver), actor);
    expect(cod.parcel.codAmountCents).toBe(25_000);
    expect(nonCod.parcel.codAmountCents).toBe(0);

    const smsJobs = await db.select({ payloadJson: outbox.payloadJson }).from(outbox).where(eq(outbox.topic, "sms.send"));
    const bookingJobs = smsJobs.filter((row) => {
      const payload = JSON.parse(row.payloadJson) as { parcelId?: string; awb?: string };
      return [cod.parcel.id, nonCod.parcel.id, cod.parcel.awb, nonCod.parcel.awb].some((value) =>
        value === payload.parcelId || value === payload.awb,
      );
    });
    expect(bookingJobs).toHaveLength(0);

    const sentToBookingPhones = await db.select({ id: smsLog.id }).from(smsLog).where(inArray(smsLog.toPhone, testPhones));
    expect(sentToBookingPhones).toHaveLength(0);
  });
});
