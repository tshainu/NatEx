import { describe, expect, test } from "bun:test";
import {
  assertMerchantRegistrationSms,
  assertPodSmsHasNoTrackingMaterial,
  containsTrackingMaterial,
  MERCHANT_REGISTRATION_ACCEPTED_SMS,
  MERCHANT_REGISTRATION_RECEIPT_SMS,
} from "./sms-policy";

describe("customer SMS tracking-material policy", () => {
  test("detects tracking placeholders, current numbers, legacy numbers, and links", () => {
    for (const body of [
      "Delivered: {{awb}}",
      "Delivered: {{tracking_number}}",
      "Delivered: {{trackUrl}}",
      "Delivered: NX2610020001",
      "Delivered: NXB-20261007-FYCWQW1NWQ",
      "Track at https://natex.example/track/NX2610020001",
      "Track at natex.example/track/",
    ]) {
      expect(containsTrackingMaterial(body)).toBe(true);
      expect(() => assertPodSmsHasNoTrackingMaterial(body)).toThrow("POD SMS must not include a tracking number or tracking link.");
    }
  });

  test("allows a POD confirmation without a tracking identifier or link", () => {
    const body = "NatEx: your parcel has been delivered. Thank you.";
    expect(containsTrackingMaterial(body)).toBe(false);
    expect(() => assertPodSmsHasNoTrackingMaterial(body)).not.toThrow();
  });

  test("accepts only the two exact merchant-registration SMS copies", () => {
    expect(() => assertMerchantRegistrationSms(MERCHANT_REGISTRATION_RECEIPT_SMS)).not.toThrow();
    expect(() => assertMerchantRegistrationSms(MERCHANT_REGISTRATION_ACCEPTED_SMS)).not.toThrow();
    for (const body of [
      `${MERCHANT_REGISTRATION_RECEIPT_SMS} NX2610020001`,
      MERCHANT_REGISTRATION_RECEIPT_SMS.replace("review.", "review!"),
      "Your application was received.",
    ]) {
      expect(() => assertMerchantRegistrationSms(body)).toThrow("Merchant-registration SMS must match an approved fixed template.");
    }
  });
});
