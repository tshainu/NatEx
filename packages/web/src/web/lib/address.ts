export const DISTRICTS_BY_PROVINCE = {
  "Western Province": ["Colombo", "Gampaha", "Kalutara"],
  "Central Province": ["Kandy", "Matale", "Nuwara Eliya"],
  "Southern Province": ["Galle", "Matara", "Hambantota"],
  "Northern Province": ["Jaffna", "Kilinochchi", "Mannar", "Mullaitivu", "Vavuniya"],
  "Eastern Province": ["Ampara", "Batticaloa", "Trincomalee"],
  "North Western Province": ["Kurunegala", "Puttalam"],
  "North Central Province": ["Anuradhapura", "Polonnaruwa"],
  "Uva Province": ["Badulla", "Monaragala"],
  "Sabaragamuwa Province": ["Kegalle", "Ratnapura"],
} as const;

export type Province = keyof typeof DISTRICTS_BY_PROVINCE;
export type District = (typeof DISTRICTS_BY_PROVINCE)[Province][number];
export const PROVINCES = Object.keys(DISTRICTS_BY_PROVINCE) as Province[];
export const DISTRICTS = Object.values(DISTRICTS_BY_PROVINCE).flat() as District[];

export interface AddressParts {
  line1: string;
  line2: string;
  district: District | "";
  province: Province | "";
}

export const EMPTY_ADDRESS: AddressParts = { line1: "", line2: "", district: "", province: "" };

export function formatAddress(parts: AddressParts): string {
  return [parts.line1.trim(), parts.line2.trim(), parts.district, parts.province]
    .filter(Boolean)
    .join(", ");
}

/**
 * Older NatEx records stored one free-text address. Keep all old address content
 * on line 1, while preselecting a district/province only when the locality is
 * recognizable. The user can review and correct the inferred dropdown values.
 */
export function addressPartsFromLegacy(value: string | null | undefined): AddressParts {
  const line1 = value?.trim() ?? "";
  const found = DISTRICTS.find((district) => new RegExp(`\\b${district}\\b`, "i").test(line1));
  if (!found) return { ...EMPTY_ADDRESS, line1 };
  const province = PROVINCES.find((p) => (DISTRICTS_BY_PROVINCE[p] as readonly string[]).includes(found)) ?? "";
  return { line1, line2: "", district: found, province };
}

export function isCompleteAddress(parts: AddressParts): boolean {
  return parts.line1.trim().length >= 3 && Boolean(parts.district && parts.province) &&
    (DISTRICTS_BY_PROVINCE[parts.province as Province] as readonly string[]).includes(parts.district);
}
