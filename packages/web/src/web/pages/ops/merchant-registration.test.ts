import { describe, expect, test } from "bun:test";
import { registrationOnboardPrefill, type MerchantRegistrationRequest } from "./merchant-registration";

const request: MerchantRegistrationRequest = {
  id: "req-1",
  businessName: "Kandy Books",
  contactName: "Amara Perera",
  phone: "0771234567",
  email: "amara@example.lk",
  district: "Kandy",
  businessType: "Retail",
  monthlyVolume: "101-500",
  notes: "Call after 10am.",
  status: "new",
  merchantId: null,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  convertedAt: null,
  receiptSmsState: "sent",
  confirmationSmsState: "not_queued",
  smsConsent: true,
};

describe("merchant registration onboarding prefill", () => {
  test("maps compatible fields and uses the district utility without fabricating a street address", () => {
    expect(registrationOnboardPrefill("branch-1", request)).toEqual({
      name: "Kandy Books",
      branchId: "branch-1",
      address: {
        line1: "",
        line2: "",
        district: "Kandy",
        province: "Central Province",
      },
      contactName: "Amara Perera",
      contactPhone: "0771234567",
    });
  });

  test("leaves unknown district values unselected and retains normal onboarding defaults", () => {
    const prefill = registrationOnboardPrefill("branch-2", {
      ...request,
      district: "Somewhere",
    });
    expect(prefill.branchId).toBe("branch-2");
    expect(prefill.address).toEqual({ line1: "", line2: "", district: "", province: "" });
  });

  test("normal onboarding starts with a completely blank address and contact", () => {
    expect(registrationOnboardPrefill("branch-3")).toEqual({
      name: "",
      branchId: "branch-3",
      address: { line1: "", line2: "", district: "", province: "" },
      contactName: "",
      contactPhone: "",
    });
  });
});
