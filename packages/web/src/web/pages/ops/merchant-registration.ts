import { DISTRICTS, EMPTY_ADDRESS, provinceForDistrict, type AddressParts } from "@/lib/address";

export interface MerchantRegistrationRequest {
  id: string;
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  district: string;
  businessType: string;
  monthlyVolume: string;
  notes: string;
  status: "new" | "converted" | "rejected";
  merchantId: string | null;
  createdAt: string | Date;
  convertedAt: string | Date | null;
  receiptSmsState: string;
  confirmationSmsState: string;
  smsConsent: boolean;
}

export interface RegistrationOnboardPrefill {
  name: string;
  branchId: string;
  address: AddressParts;
  contactName: string;
  contactPhone: string;
}

/** Prefill only application data compatible with merchant onboarding. */
export function registrationOnboardPrefill(
  defaultBranchId: string,
  request?: MerchantRegistrationRequest,
): RegistrationOnboardPrefill {
  if (!request) {
    return {
      name: "",
      branchId: defaultBranchId,
      address: { ...EMPTY_ADDRESS },
      contactName: "",
      contactPhone: "",
    };
  }

  const district = DISTRICTS.find(
    (candidate) => candidate.toLowerCase() === request.district.trim().toLowerCase(),
  ) ?? "";
  return {
    name: request.businessName,
    branchId: defaultBranchId,
    // The application contains no street address: leave both lines empty for staff.
    address: {
      ...EMPTY_ADDRESS,
      district,
      province: provinceForDistrict(district),
    },
    contactName: request.contactName,
    contactPhone: request.phone,
  };
}
