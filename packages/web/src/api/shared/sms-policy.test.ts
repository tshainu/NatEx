import { describe, expect, test } from "bun:test";
import {
  assertDeliveryFailureSms,
  assertRescheduleSms,
  assertMerchantRegistrationSms,
  assertPodSmsHasNoTrackingMaterial,
  buildRescheduleSms,
  containsTrackingMaterial,
  MERCHANT_ONBOARDING_WELCOME_SMS,
  MERCHANT_REGISTRATION_ACCEPTED_SMS,
  MERCHANT_REGISTRATION_RECEIPT_SMS,
  NATEX_SMS_SENDER_ID,
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

  test("allows a short failed-delivery notice to identify the parcel", () => {
    const body = "NatEx NX4400440040: delivery attempt 1 of 3 failed (Consignee unreachable). Call 0772772708 to rearrange. natex.lk/track/NX4400440040";
    expect(() => assertDeliveryFailureSms(body)).not.toThrow();
  });

  test("rejects empty, multiline, or oversized failed-delivery SMS", () => {
    for (const body of ["", "   ", "NatEx notice\nsecond line", "x".repeat(321)]) {
      expect(() => assertDeliveryFailureSms(body)).toThrow(
        "Failed-delivery SMS must be a non-empty, single-line message of at most 320 characters.",
      );
    }
  });

  test("accepts only exact approved merchant-registration and onboarding SMS copies", () => {
    expect(() => assertMerchantRegistrationSms(MERCHANT_REGISTRATION_RECEIPT_SMS)).not.toThrow();
    expect(() => assertMerchantRegistrationSms(MERCHANT_REGISTRATION_ACCEPTED_SMS)).not.toThrow();
    expect(() => assertMerchantRegistrationSms(MERCHANT_ONBOARDING_WELCOME_SMS)).not.toThrow();
    expect(MERCHANT_ONBOARDING_WELCOME_SMS).toContain("Congratulations!");
    expect(MERCHANT_ONBOARDING_WELCOME_SMS).toContain("Passwords are never sent by SMS");
    expect(MERCHANT_ONBOARDING_WELCOME_SMS).not.toMatch(/password\s*[:=]/i);
    for (const body of [
      `${MERCHANT_REGISTRATION_RECEIPT_SMS} NX2610020001`,
      MERCHANT_REGISTRATION_RECEIPT_SMS.replace("review.", "review!"),
      "Your application was received.",
    ]) {
      expect(() => assertMerchantRegistrationSms(body)).toThrow("Merchant-registration SMS must match an approved fixed template.");
    }
  });

  test("builds the only approved short ASCII receiver reschedule message", () => {
    const body = buildRescheduleSms({
      trackingNumber: "NXB-20261105-ABC123",
      newDate: "2026-11-10",
      reason: "Address incomplete / call 0771234567 or mail help@example.com",
    });
    expect(body).toBe("NatEx: Tracking NXB-20261105-ABC123. Delivery rescheduled to 2026-11-10. Reason: Address incomplete call or mail.");
    expect(body.length).toBeLessThanOrEqual(160);
    expect(/^[\x20-\x7e]+$/.test(body)).toBe(true);
    expect(NATEX_SMS_SENDER_ID).toBe("NatEx");
    expect(() => assertRescheduleSms(body)).not.toThrow();
  });

  test("rejects arbitrary copy, links, malformed tracking, and impossible reschedule dates", () => {
    for (const body of [
      "NatEx: Your parcel is delayed; call 0771234567.",
      "NatEx: Tracking NX2610020001. Delivery rescheduled to 2026-02-31. Reason: Weather.",
      "NatEx: Tracking NX2610020001. Delivery rescheduled to 2026-11-10. Reason: Weather. https://example.com",
    ]) {
      expect(() => assertRescheduleSms(body)).toThrow();
    }
    expect(() => buildRescheduleSms({ trackingNumber: "NX1", newDate: "2026-02-31", reason: "Address" })).toThrow();
  });
});
