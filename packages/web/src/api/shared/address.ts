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
export const PROVINCE_BY_DISTRICT = Object.fromEntries(
  PROVINCES.flatMap((province) => DISTRICTS_BY_PROVINCE[province].map((district) => [district, province] as const)),
) as Record<District, Province>;

export function provinceForDistrict(district: District | ""): Province | "" {
  return district ? PROVINCE_BY_DISTRICT[district] : "";
}

/** Read the trailing district and province emitted by NatEx's structured address formatter. */
export function districtFromAddress(address: string | null | undefined): District | null {
  const parts = (address ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const district = parts.at(-2) as District | undefined;
  const province = parts.at(-1);
  return district && DISTRICTS.includes(district) && PROVINCE_BY_DISTRICT[district] === province ? district : null;
}
