import type { OutboxEntry } from "./outbox";

export type StopView =
  | "todo"
  | "queued_delivered"
  | "queued_failed"
  | "delivered"
  | "failed"
  | "removed"
  | "problem";

export interface StopStateSnapshot {
  /** Current server parcel status, separate from the runsheet item's state. */
  status: string | null;
  /** Runsheet item state, which may lag behind the parcel status. */
  state: string;
}

export interface RiderAssignment {
  runsheetId: string;
  revision: string;
}

/**
 * Reconcile a runsheet item with the parcel's authoritative current status and
 * this phone's outbox. The parcel can be delivered by another device while the
 * runsheet item is still pending; that must never leave a second Deliver action
 * available. Keep the outbox entry attached so its server verdict remains
 * visible for audit/review.
 */
export function resolveStopView(
  stop: StopStateSnapshot,
  entry: OutboxEntry | null,
): { view: StopView; entry: OutboxEntry | null } {
  if (stop.status === "Delivered" || stop.state === "delivered") {
    return { view: "delivered", entry };
  }
  if (entry?.state === "pending") {
    return { view: entry.kind === "delivery.deliver" ? "queued_delivered" : "queued_failed", entry };
  }
  if (entry && (entry.state === "rejected" || entry.state === "conflict")) {
    return { view: "problem", entry };
  }
  if (entry && stop.state === "pending" && (entry.state === "applied" || entry.state === "duplicate")) {
    if (entry.kind === "delivery.deliver") return { view: "delivered", entry };
    // A dispatched redelivery resets the active runsheet item to pending and
    // the parcel to OutForDelivery. The append-only failure remains in history,
    // but its settled local outbox row must not disable this new assignment.
    if (stop.status === "OutForDelivery") return { view: "todo", entry: null };
    return { view: "failed", entry };
  }
  if (stop.state === "failed") return { view: "failed", entry };
  if (stop.state === "removed") return { view: "removed", entry };
  return { view: "todo", entry };
}

/**
 * Whether sync has reported a different active run or a new revision of the
 * same run. Revision changes include delivered/failed stops, so run detail must
 * be refreshed even when the runsheet id itself stays the same.
 */
export function assignmentNeedsRefresh(
  next: RiderAssignment | null,
  previous: RiderAssignment | null,
  heldRunsheetId: string | null,
): boolean {
  if (!next) return heldRunsheetId !== null;
  if (next.runsheetId !== heldRunsheetId) return true;
  return previous?.runsheetId === next.runsheetId && previous.revision !== next.revision;
}
