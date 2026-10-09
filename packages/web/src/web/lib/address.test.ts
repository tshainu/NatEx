import { describe, expect, test } from "bun:test";
import { addressPartsFromLegacy, DISTRICTS_BY_PROVINCE, formatAddress, isCompleteAddress } from "./address";

describe("Sri Lankan structured addresses", () => {
  test("lists all 25 districts under their provinces", () => {
    expect(Object.values(DISTRICTS_BY_PROVINCE).flat()).toHaveLength(25);
    expect(DISTRICTS_BY_PROVINCE["Western Province"]).toContain("Colombo");
    expect(DISTRICTS_BY_PROVINCE["Northern Province"]).toContain("Jaffna");
  });

  test("formats line 1, optional line 2, district and province", () => {
    expect(formatAddress({ line1: "No. 12 Temple Road", line2: "Near clock tower", district: "Kandy", province: "Central Province" }))
      .toBe("No. 12 Temple Road, Near clock tower, Kandy, Central Province");
    expect(formatAddress({ line1: "No. 12 Temple Road", line2: "", district: "Kandy", province: "Central Province" }))
      .toBe("No. 12 Temple Road, Kandy, Central Province");
  });

  test("recognizes existing locality text without discarding the original address", () => {
    expect(addressPartsFromLegacy("44 Galle Road, Colombo 04")).toEqual({
      line1: "44 Galle Road, Colombo 04", line2: "", district: "Colombo", province: "Western Province",
    });
    expect(addressPartsFromLegacy("12 Main Street").district).toBe("");
  });

  test("does not allow a district from a different province", () => {
    expect(isCompleteAddress({ line1: "12 Main Street", line2: "", district: "Kandy", province: "Western Province" })).toBe(false);
    expect(isCompleteAddress({ line1: "12 Main Street", line2: "", district: "Kandy", province: "Central Province" })).toBe(true);
  });
});
