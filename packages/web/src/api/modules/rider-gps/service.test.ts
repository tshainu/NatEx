import { describe, expect, test } from "bun:test";
import {
  MAX_ACCURACY_METERS,
  MAX_SPEED_MPS,
  gpsPointIsValid,
  gpsSegmentIsValid,
  haversineMeters,
} from "./service";

const now = Date.parse("2026-11-24T06:00:00.000Z");
const point = (overrides: Partial<Parameters<typeof gpsPointIsValid>[0]> = {}) => ({
  clientPointId: "test-point",
  capturedAt: new Date(now).toISOString(),
  latitude: 6.9271,
  longitude: 79.8612,
  accuracyMeters: 25,
  speedMps: 8,
  ...overrides,
});

describe("rider GPS validation", () => {
  test("calculates a Colombo-scale Haversine segment", () => {
    const distance = haversineMeters(
      { latitudeE6: 6_927_100, longitudeE6: 79_861_200 },
      { latitudeE6: 6_928_000, longitudeE6: 79_861_200 },
    );
    expect(distance).toBeGreaterThan(95);
    expect(distance).toBeLessThan(105);
  });

  test("accepts accurate points at the configured boundary and rejects poor accuracy", () => {
    expect(gpsPointIsValid(point({ accuracyMeters: MAX_ACCURACY_METERS }), now)).toBe(true);
    expect(gpsPointIsValid(point({ accuracyMeters: MAX_ACCURACY_METERS + 1 }), now)).toBe(false);
  });

  test("rejects malformed coordinates, future points, and excessive device speed", () => {
    expect(gpsPointIsValid(point({ latitude: 91 }), now)).toBe(false);
    expect(gpsPointIsValid(point({ capturedAt: new Date(now + 60_001).toISOString() }), now)).toBe(false);
    expect(gpsPointIsValid(point({ speedMps: MAX_SPEED_MPS + 1 }), now)).toBe(false);
  });

  test("rejects unrealistic segments by distance and speed", () => {
    expect(gpsSegmentIsValid(4_999, 200)).toBe(true);
    expect(gpsSegmentIsValid(5_001, 200)).toBe(false);
    expect(gpsSegmentIsValid(300, 10)).toBe(true);
    expect(gpsSegmentIsValid(1_000, 10)).toBe(false);
    expect(gpsSegmentIsValid(1_000, 1)).toBe(false);
  });
});
