import { addressPartsFromLegacy, type AddressParts } from "@/lib/address";

export interface StaffOnboardingRequest {
  id: string;
  branchId: string;
  name: string;
  pickupRiderId: string | null;
  vatNo: string | null;
  address: string;
  lat: number | null;
  lng: number | null;
  contactName: string;
  contactPhone: string;
  codEnabled: boolean;
  podPolicy: "signature" | "otp" | "photo" | string;
  createdById: string;
  createdByName: string;
  status: "pending" | "approved" | string;
  createdAt: string | Date;
  approvedAt: string | Date | null;
  approvedById: string | null;
  approvedByName: string | null;
  approvedMerchantId: string | null;
}

export interface StaffOnboardingPrefill {
  name: string;
  branchId: string;
  pickupRiderId: string;
  vatNo: string;
  address: AddressParts;
  contactName: string;
  contactPhone: string;
  codEnabled: boolean;
  podPolicy: "signature" | "otp" | "photo";
}

export function staffOnboardingPrefill(request: StaffOnboardingRequest): StaffOnboardingPrefill {
  const policy = request.podPolicy === "otp" || request.podPolicy === "photo" ? request.podPolicy : "signature";
  const address = addressPartsFromLegacy(request.address);
  const suffix = address.district && address.province ? `, ${address.district}, ${address.province}` : "";
  if (suffix && request.address.toLowerCase().endsWith(suffix.toLowerCase())) {
    address.line1 = request.address.slice(0, -suffix.length).trim();
  }
  return {
    name: request.name,
    branchId: request.branchId,
    pickupRiderId: request.pickupRiderId ?? "",
    vatNo: request.vatNo ?? "",
    address,
    contactName: request.contactName,
    contactPhone: request.contactPhone,
    codEnabled: request.codEnabled,
    podPolicy: policy,
  };
}
