import { DISTRICTS, districtFromAddress, type District } from "../../shared/address";

export interface DestinationLocationCandidate {
  name: string;
  address: string;
  type: string;
}

export type DestinationResolutionStatus =
  | "resolved"
  | "district-not-found"
  | "no-location-for-district"
  | "multiple-locations-for-district";

export interface DestinationDistrictResolution {
  destinationDistrict: District | null;
  destinationBranchName: string | null;
  destinationResolutionStatus: DestinationResolutionStatus;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read the recipient district from NatEx's structured address tail first. For
 * legacy/free-text records, inspect address components from the end so a street
 * such as "Colombo Road, Jaffna" resolves to Jaffna rather than the first match.
 */
export function destinationDistrictFromAddress(address: string | null | undefined): District | null {
  const value = address?.trim();
  if (!value) return null;

  const structured = districtFromAddress(value);
  if (structured) return structured;

  const segments = value
    .normalize("NFKC")
    .split(/[,;\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    const matches = DISTRICTS.filter((district) =>
      new RegExp(`\\b${escapeRegExp(district)}\\b`, "i").test(segment),
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return null;
  }
  return null;
}

function locationLabel(location: DestinationLocationCandidate): string {
  const type = location.type.toLowerCase() === "hub" ? "hub" : "branch";
  const name = location.name.trim().replace(/\s+(?:hub|branch)$/i, "").trim();
  return `${name || location.name.trim()} ${type}`.trim();
}

/**
 * Match the recipient's district to active Admin → Branches addresses. A unique
 * hub wins over branches in the same district; a branch is used only when no
 * hub is listed there. Ambiguous districts are deliberately not assigned.
 */
export function resolveDestinationDistrict(
  district: District | null,
  locations: readonly DestinationLocationCandidate[],
): DestinationDistrictResolution {
  if (!district) {
    return {
      destinationDistrict: null,
      destinationBranchName: null,
      destinationResolutionStatus: "district-not-found",
    };
  }

  const districtLocations = locations.filter(
    (location) => destinationDistrictFromAddress(location.address) === district,
  );
  const hubs = districtLocations.filter((location) => location.type.toLowerCase() === "hub");
  const preferred = hubs.length > 0
    ? hubs
    : districtLocations.filter((location) => location.type.toLowerCase() === "branch");

  if (preferred.length === 0) {
    return {
      destinationDistrict: district,
      destinationBranchName: null,
      destinationResolutionStatus: "no-location-for-district",
    };
  }
  if (preferred.length > 1) {
    return {
      destinationDistrict: district,
      destinationBranchName: null,
      destinationResolutionStatus: "multiple-locations-for-district",
    };
  }

  return {
    destinationDistrict: district,
    destinationBranchName: locationLabel(preferred[0]!),
    destinationResolutionStatus: "resolved",
  };
}
