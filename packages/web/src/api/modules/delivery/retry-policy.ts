import { MAX_DELIVERY_ATTEMPTS } from "../parcels/state-machine";

export const RIDER_RETRY_WINDOW_MS = 72 * 60 * 60 * 1000;

export interface RiderRetryPolicyInput {
  nowMs: number;
  expiresAtMs: number;
  attemptsUsed: number;
  reasonAllowsReattempt: boolean;
  reasonTriggersRto: boolean;
  retryCaseOpen: boolean;
  isLatestFailure: boolean;
  parcelStatus: string;
  assignedToRider: boolean;
  runDispatched: boolean;
  stopFailed: boolean;
}

export type RiderRetryDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/** Pure eligibility rule; the service supplies server-derived state only. */
export function riderRetryDecision(input: RiderRetryPolicyInput): RiderRetryDecision {
  if (!input.retryCaseOpen) return { allowed: false, reason: "This retry window is no longer open." };
  if (!input.isLatestFailure) return { allowed: false, reason: "Only the latest failed attempt can be retried." };
  if (input.nowMs >= input.expiresAtMs) return { allowed: false, reason: "The 72-hour retry window has expired. Ask Ops for the next step." };
  if (input.reasonTriggersRto || !input.reasonAllowsReattempt) {
    return { allowed: false, reason: "This failure reason requires Ops or merchant instruction." };
  }
  if (input.attemptsUsed >= MAX_DELIVERY_ATTEMPTS) {
    return { allowed: false, reason: `All ${MAX_DELIVERY_ATTEMPTS} counted attempts have been used.` };
  }
  if (input.parcelStatus !== "DeliveryAttempted") {
    return { allowed: false, reason: `Parcel is ${input.parcelStatus}; a Rider retry is not available in this state.` };
  }
  if (!input.assignedToRider || !input.runDispatched || !input.stopFailed) {
    return { allowed: false, reason: "This parcel is not on your active dispatched run. Ask Ops to assign it to a run." };
  }
  return { allowed: true };
}

export function retryDeadline(firstFailureAt: Date): Date {
  // SQLite integer timestamps in this schema are persisted at second precision.
  // Match that storage precision so the API and eligibility gate share the same cutoff.
  const persistedFailureMs = Math.floor(firstFailureAt.getTime() / 1000) * 1000;
  return new Date(persistedFailureMs + RIDER_RETRY_WINDOW_MS);
}
