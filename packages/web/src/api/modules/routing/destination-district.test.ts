import { describe, expect, test } from "bun:test";
import {
  destinationDistrictFromAddress,
  resolveDestinationDistrict,
  type DestinationLocationCandidate,
} from "./destination-district";

const locations: DestinationLocationCandidate[] = [
  {
    name: "Colombo Central",
    type: "branch",
    address: "128 Union Place, Colombo, Western Province",
  },
  {
    name: "Colombo Main Hub",
    type: "hub",
    address: "Colombo Main Street, Colombo, Western Province",
  },
  {
    name: "Jaffna Branch",
    type: "hub",
    address: "Jaffna Town, Jaffna, Northern Province",
  },
  {
    name: "Galle Outlet",
    type: "branch",
    address: "Galle Main Street, Galle, Southern Province",
  },
];

describe("destination district resolution", () => {
  test("reads the structured district/province tail and legacy address components", () => {
    expect(destinationDistrictFromAddress("No. 10, Main Street, Jaffna, Northern Province")).toBe("Jaffna");
    expect(destinationDistrictFromAddress("12 Colombo Road, Jaffna Town")).toBe("Jaffna");
    expect(destinationDistrictFromAddress("No. 5, Mannar")).toBe("Mannar");
    expect(destinationDistrictFromAddress("No. 7, Receiver Street")).toBeNull();
  });

  test("prefers the unique active hub over a branch in the same district", () => {
    expect(resolveDestinationDistrict("Colombo", locations)).toEqual({
      destinationDistrict: "Colombo",
      destinationBranchName: "Colombo Main hub",
      destinationResolutionStatus: "resolved",
    });
  });

  test("uses a unique branch when no hub is listed for the district", () => {
    expect(resolveDestinationDistrict("Galle", locations)).toEqual({
      destinationDistrict: "Galle",
      destinationBranchName: "Galle Outlet branch",
      destinationResolutionStatus: "resolved",
    });
  });

  test("keeps the district visible when the active directory has no location there", () => {
    expect(resolveDestinationDistrict("Mannar", locations)).toEqual({
      destinationDistrict: "Mannar",
      destinationBranchName: null,
      destinationResolutionStatus: "no-location-for-district",
    });
  });

  test("does not guess when multiple same-type locations match one district", () => {
    expect(resolveDestinationDistrict("Jaffna", [
      ...locations,
      { name: "Jaffna North Hub", type: "hub", address: "Jaffna North, Jaffna, Northern Province" },
    ])).toEqual({
      destinationDistrict: "Jaffna",
      destinationBranchName: null,
      destinationResolutionStatus: "multiple-locations-for-district",
    });
  });
});
