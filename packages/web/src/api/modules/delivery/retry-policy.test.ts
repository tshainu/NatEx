import { describe, expect, test } from "bun:test";
import { MAX_DELIVERY_ATTEMPTS } from "../parcels/state-machine";
import { RIDER_RETRY_WINDOW_MS, retryDeadline, riderRetryDecision } from "./retry-policy";

const firstFailure = new Date("2026-11-10T10:00:00Z");
const eligible = {
  nowMs: firstFailure.getTime() + 60_000,
  expiresAtMs: retryDeadline(firstFailure).getTime(),
  attemptsUsed: 1,
  reasonAllowsReattempt: true,
  reasonTriggersRto: false,
  retryCaseOpen: true,
  isLatestFailure: true,
  parcelStatus: "DeliveryAttempted",
  assignedToRider: true,
  runDispatched: true,
  stopFailed: true,
};

describe("Rider retry policy", () => {
  test("uses a fixed 72-hour deadline from the first failure", () => {
    expect(RIDER_RETRY_WINDOW_MS).toBe(72 * 60 * 60 * 1000);
    expect(retryDeadline(firstFailure).getTime()).toBe(firstFailure.getTime() + RIDER_RETRY_WINDOW_MS);
    const subsecondFailure = new Date("2026-11-10T10:00:00.987Z");
    expect(retryDeadline(subsecondFailure).getTime()).toBe(Date.parse("2026-11-13T10:00:00.000Z"));
    expect(riderRetryDecision({ ...eligible, nowMs: eligible.expiresAtMs - 1 })).toEqual({ allowed: true });
    expect(riderRetryDecision({ ...eligible, nowMs: eligible.expiresAtMs })).toMatchObject({ allowed: false });
  });

  test("rejects non-retryable and immediate-return reasons", () => {
    expect(riderRetryDecision({ ...eligible, reasonAllowsReattempt: false })).toMatchObject({ allowed: false });
    expect(riderRetryDecision({ ...eligible, reasonTriggersRto: true })).toMatchObject({ allowed: false });
  });

  test("rejects exhausted attempts, a non-latest record, stale state or closed case", () => {
    expect(riderRetryDecision({ ...eligible, attemptsUsed: MAX_DELIVERY_ATTEMPTS })).toMatchObject({ allowed: false });
    expect(riderRetryDecision({ ...eligible, isLatestFailure: false })).toMatchObject({ allowed: false });
    expect(riderRetryDecision({ ...eligible, parcelStatus: "OutForDelivery" })).toMatchObject({ allowed: false });
    expect(riderRetryDecision({ ...eligible, retryCaseOpen: false })).toMatchObject({ allowed: false });
  });

  test("requires the same Rider to own a failed stop on an active dispatched run", () => {
    expect(riderRetryDecision({ ...eligible, assignedToRider: false })).toMatchObject({ allowed: false });
    expect(riderRetryDecision({ ...eligible, runDispatched: false })).toMatchObject({ allowed: false });
    expect(riderRetryDecision({ ...eligible, stopFailed: false })).toMatchObject({ allowed: false });
  });
});
