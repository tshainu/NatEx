import { describe, expect, test } from "bun:test";
import { formatAddress } from "@/lib/address";
import { staffOnboardingPrefill, type StaffOnboardingRequest } from "./staff-onboarding-request";

const request: StaffOnboardingRequest = {
  id: "mon-1",
  branchId: "branch-source",
  name: "Kandy Books",
  pickupRiderId: "rider-1",
  vatNo: "VAT-42",
  address: "No. 4 Lake Road, Kandy, Central Province",
  lat: null,
  lng: null,
  contactName: "Amara Perera",
  contactPhone: "0771234567",
  codEnabled: false,
  podPolicy: "photo",
  createdById: "ops-1",
  createdByName: "Ops Staff",
  status: "pending",
  createdAt: new Date("2026-10-01T10:00:00Z"),
  approvedAt: null,
  approvedById: null,
  approvedByName: null,
  approvedMerchantId: null,
};

describe("Operations onboarding prefill", () => {
  test("prefills the persisted branch and submitted merchant fields for approval", () => {
    const prefill = staffOnboardingPrefill(request);
    expect(prefill).toEqual({
      name: "Kandy Books",
      branchId: "branch-source",
      pickupRiderId: "rider-1",
      vatNo: "VAT-42",
      address: { line1: "No. 4 Lake Road", line2: "", district: "Kandy", province: "Central Province" },
      contactName: "Amara Perera",
      contactPhone: "0771234567",
      codEnabled: false,
      podPolicy: "photo",
    });
    expect(formatAddress(prefill.address)).toBe(request.address);
  });

  test("does not fall back from an unknown source branch or policy to a different branch", () => {
    expect(staffOnboardingPrefill({ ...request, branchId: "branch-unknown", podPolicy: "unknown" })).toMatchObject({
      branchId: "branch-unknown",
      podPolicy: "signature",
    });
  });
});
