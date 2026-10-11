import { DISTRICTS_BY_PROVINCE, DISTRICTS, districtFromAddress, provinceForDistrict, type District, type Province } from "../../api/shared/address";
export { DISTRICTS_BY_PROVINCE, DISTRICTS, PROVINCES, PROVINCE_BY_DISTRICT, districtFromAddress, provinceForDistrict } from "../../api/shared/address";
export type { District, Province } from "../../api/shared/address";

export interface AddressParts {
  line1: string;
  line2: string;
  district: District | "";
  province: Province | "";
}

export const EMPTY_ADDRESS: AddressParts = { line1: "", line2: "", district: "", province: "" };

function cleanAddressLine(value: string): string {
  return value.trim().replace(/\s*,\s*/g, ", ").replace(/^(?:,\s*)+|(?:\s*,\s*)+$/g, "").trim();
}

export function formatAddress(parts: AddressParts): string {
  return [cleanAddressLine(parts.line1), cleanAddressLine(parts.line2), parts.district, parts.province]
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
  const found = districtFromAddress(line1) ?? DISTRICTS.find((district) => new RegExp(`\\b${district}\\b`, "i").test(line1));
  if (!found) return { ...EMPTY_ADDRESS, line1 };
  const province = provinceForDistrict(found);
  return { line1, line2: "", district: found, province };
}

export function isCompleteAddress(parts: AddressParts): boolean {
  return parts.line1.trim().length >= 3 && Boolean(parts.district && parts.province) &&
    (DISTRICTS_BY_PROVINCE[parts.province as Province] as readonly string[]).includes(parts.district);
}
