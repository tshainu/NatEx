import { describe, expect, test } from "bun:test";
import { formatCoordinates, googleMapsDirectionsUrl, hasValidCoordinates } from "./maps";

describe("merchant Google Maps directions", () => {
  test("uses valid GPS coordinates as the directions destination", () => {
    expect(
      googleMapsDirectionsUrl({ latitude: 6.9271, longitude: 79.8612, address: "Colombo" }),
    ).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=6.9271%2C79.8612&travelmode=driving",
    );
    expect(formatCoordinates(6.9271, 79.8612)).toBe("6.927100, 79.861200");
  });

  test("uses the saved address when the GPS pin is missing or invalid", () => {
    expect(
      googleMapsDirectionsUrl({ latitude: null, longitude: null, address: "Jaffna Main Street" }),
    ).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=Jaffna%20Main%20Street&travelmode=driving",
    );
    expect(googleMapsDirectionsUrl({ latitude: 91, longitude: 0, address: "Jaffna" })).toContain(
      "destination=Jaffna&",
    );
    expect(hasValidCoordinates(91, 0)).toBe(false);
  });

  test("does not create a directions link when neither GPS nor address is available", () => {
    expect(googleMapsDirectionsUrl({ latitude: null, longitude: null, address: "   " })).toBeNull();
    expect(formatCoordinates(6.9, null)).toBeNull();
    expect(hasValidCoordinates(0, 0)).toBe(true);
  });
});
