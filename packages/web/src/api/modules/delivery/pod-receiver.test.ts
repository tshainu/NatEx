import { describe, expect, test } from "bun:test";
import {
  deliveryOtpIssue,
  normaliseReceiverPhone,
  receiverPodAuditFields,
  requiredDeliveryProof,
} from "./pod-receiver";

const now = Date.UTC(2026, 10, 8, 12);
const challenge = {
  awb: "NX123456789",
  sentToPhone: "+94771234567",
  verifiedAt: new Date(now - 60_000),
  consumedAt: new Date(now - 60_000),
  expiresAt: new Date(now + 10 * 60_000),
};

describe("delivery receiver OTP binding", () => {
  test("accepts only a consumed, verified challenge bound to the same AWB and receiver phone", () => {
    expect(deliveryOtpIssue(challenge, {
      awb: "NX123456789",
      receiverPhone: "0771234567",
      now,
    })).toBeNull();
    expect(normaliseReceiverPhone("0771234567")).toBe("+94771234567");
  });

  test("rejects missing/unconsumed challenges and mismatched AWBs or phones", () => {
    expect(deliveryOtpIssue(null, { awb: "NX123456789", receiverPhone: "+94771234567", now })).toBe("required");
    expect(deliveryOtpIssue({ ...challenge, consumedAt: null }, {
      awb: "NX123456789", receiverPhone: "+94771234567", now,
    })).toBe("unverified");
    expect(deliveryOtpIssue(challenge, {
      awb: "NX987654321", receiverPhone: "+94771234567", now,
    })).toBe("binding");
    expect(deliveryOtpIssue(challenge, {
      awb: "NX123456789", receiverPhone: "+94770000000", now,
    })).toBe("binding");
  });

  test("rejects challenges verified after expiry or outside the offline completion grace", () => {
    expect(deliveryOtpIssue({
      ...challenge,
      verifiedAt: new Date(now - 60_000),
      consumedAt: new Date(now - 60_000),
      expiresAt: new Date(now - 90_000),
    }, { awb: "NX123456789", receiverPhone: "+94771234567", now })).toBe("expired");
    expect(deliveryOtpIssue({
      ...challenge,
      verifiedAt: new Date(now - 31 * 60_000),
      consumedAt: new Date(now - 31 * 60_000),
    }, { awb: "NX123456789", receiverPhone: "+94771234567", now })).toBe("expired");
  });
});

describe("POD receiver audit", () => {
  test("persists a canonical phone and four NIC digits, never a full NIC field", () => {
    const saved = receiverPodAuditFields({ receiverPhone: "0771234567", receiverNicLast4: "5678" });
    expect(saved).toEqual({ receiverPhone: "+94771234567", receiverNicLast4: "5678" });
    expect(Object.keys(saved).sort()).toEqual(["receiverNicLast4", "receiverPhone"]);
  });

  test("allows the receiver NIC to be omitted from POD", () => {
    expect(receiverPodAuditFields({ receiverPhone: "0771234567" })).toEqual({
      receiverPhone: "+94771234567",
      receiverNicLast4: null,
    });
  });

  test("rejects a full NIC value from the server persistence boundary", () => {
    expect(() => receiverPodAuditFields({
      receiverPhone: "+94771234567",
      receiverNicLast4: "200012345678",
    })).toThrow("last four digits");
  });
});

describe("delivery proof policy", () => {
  test("Rider sessions use signature regardless of the merchant's prior OTP/photo policy", () => {
    expect(requiredDeliveryProof("rider", "otp")).toBe("signature");
    expect(requiredDeliveryProof("rider", "photo")).toBe("signature");
  });

  test("back-office delivery keeps the merchant-configured method", () => {
    expect(requiredDeliveryProof("ops", "otp")).toBe("otp");
    expect(requiredDeliveryProof("admin", "photo")).toBe("photo");
  });
});
