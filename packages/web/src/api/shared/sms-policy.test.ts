import { describe, expect, test } from "bun:test";
import {
  assertArrivalNoticeSms,
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
  removeLeadingNatExPrefix,
} from "./sms-policy";

describe("customer SMS tracking-material policy", () => {
  test("removes only the exact leading NatEx colon prefix once", () => {
    expect(removeLeadingNatExPrefix("NatEx: Your parcel arrived.")).toBe("Your parcel arrived.");
    expect(removeLeadingNatExPrefix("NatEx: NatEx: Your parcel arrived.")).toBe("NatEx: Your parcel arrived.");
    expect(removeLeadingNatExPrefix("NatEx your parcel arrived.")).toBe("NatEx your parcel arrived.");
    expect(removeLeadingNatExPrefix("Your parcel arrived. NatEx: call us.")).toBe("Your parcel arrived. NatEx: call us.");
  });

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

  test("allows a short failed-delivery notice to identify the parcel without a tracking link", () => {
    const body = "Dear Ana, your order NX4400440040 has been rescheduled due to an unavailable receiver. Hotline: +94772772708.";
    expect(() => assertDeliveryFailureSms(body)).not.toThrow();
  });

  test("rejects empty, multiline, or oversized failed-delivery SMS", () => {
    for (const body of ["", "   ", "NatEx notice\nsecond line", "x".repeat(321)]) {
      expect(() => assertDeliveryFailureSms(body)).toThrow(
        "Failed-delivery SMS must be a non-empty, single-line message of at most 320 characters.",
      );
    }
  });

  test("permits a short arrival notice with an AWB, but rejects links or missing identifiers", () => {
    expect(() => assertArrivalNoticeSms("Dear Ana, your parcel NX800002000 has arrived at the hub.")).not.toThrow();
    expect(() => assertArrivalNoticeSms("Dear Ana, your parcel has arrived at the hub.")).toThrow("must include the tracking number");
    expect(() => assertArrivalNoticeSms("NX800002000 https://natex.lk/track/NX800002000")).toThrow("must not include a link");
    expect(() => assertArrivalNoticeSms("NX800002000\nsecond line")).toThrow("single-line message");
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
    expect(body).toBe("Tracking NXB-20261105-ABC123. Delivery rescheduled to 2026-11-10. Reason: Address incomplete call or mail.");
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
