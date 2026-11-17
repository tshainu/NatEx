import { describe, expect, test } from "bun:test";
import { toPublicLocations } from "./public-locations";

describe("toPublicLocations", () => {
  test("returns active map fields only and converts stored microdegrees", () => {
    const locations = toPublicLocations([
      {
        id: "internal-id",
        code: "JFN01",
        name: "Jaffna Branch",
        address: "Nallur, Jaffna",
        type: "hub",
        status: "active",
        lat: 9_664_381,
        lng: 80_030_575,
        phone: "+94123456789",
        counterRateCardId: "private-rate-card-id",
      },
      {
        id: "missing-coordinate-id",
        code: "KIL01",
        name: "Kilinochchi Hub",
        address: "Kilinochchi",
        type: "hub",
        status: "active",
        lat: null,
        lng: null,
      },
      {
        id: "inactive-id",
        code: "OLD01",
        name: "Old Location",
        address: "Inactive address",
        type: "branch",
        status: "inactive",
        lat: 7_000_000,
        lng: 80_000_000,
      },
    ]);

    expect(locations).toEqual([
      {
        code: "JFN01",
        name: "Jaffna Branch",
        address: "Nallur, Jaffna",
        type: "hub",
        latitude: 9.664381,
        longitude: 80.030575,
      },
      {
        code: "KIL01",
        name: "Kilinochchi Hub",
        address: "Kilinochchi",
        type: "hub",
        latitude: null,
        longitude: null,
      },
    ]);
    expect(JSON.stringify(locations)).not.toContain("internal-id");
    expect(JSON.stringify(locations)).not.toContain("+94123456789");
    expect(JSON.stringify(locations)).not.toContain("private-rate-card-id");
  });
});
