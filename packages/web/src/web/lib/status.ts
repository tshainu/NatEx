/**
 * Status → colour. The five groups are locked in design.md and used identically
 * in web and mobile; nothing outside this file may pick a status colour.
 *
 * The status *list* is not duplicated here — parcels.stateMachine serves the
 * enum and the transition table so the UI never holds a second copy (§6). This
 * file is presentation only.
 */

export type StatusGroup = "created" | "moving" | "good" | "warn" | "bad";

const GROUPS: Record<string, StatusGroup> = {
  Booked: "created",

  PickedUp: "moving",
  AtOriginHub: "moving",
  Bagged: "moving",
  InTransit: "moving",
  AtDestHub: "moving",
  OutForDelivery: "moving",

  Delivered: "good",
  RTODelivered: "good",

  DeliveryAttempted: "warn",
  OnHold: "warn",
  RTOInitiated: "warn",
  RTOInTransit: "warn",

  Lost: "bad",
  Damaged: "bad",
  Cancelled: "bad",
  ReturnedToMerchant: "bad",
};

export const GROUP_COLOUR: Record<StatusGroup, string> = {
  created: "#64748B",
  moving: "#F59E0B",
  good: "#10B981",
  warn: "#F43F5E",
  bad: "#9F1239",
};

export const GROUP_LABEL: Record<StatusGroup, string> = {
  created: "Created",
  moving: "In custody",
  good: "Delivered",
  warn: "Exception",
  bad: "Failed",
};

export function statusGroup(status: string): StatusGroup {
  return GROUPS[status] ?? "created";
}

export function statusColour(status: string): string {
  return GROUP_COLOUR[statusGroup(status)];
}

/** Order the ops board counts sensibly rather than alphabetically. */
export const BOARD_ORDER = [
  "Booked",
  "PickedUp",
  "AtOriginHub",
  "Bagged",
  "InTransit",
  "AtDestHub",
  "OutForDelivery",
  "Delivered",
  "DeliveryAttempted",
  "OnHold",
  "RTOInitiated",
  "RTOInTransit",
  "RTODelivered",
  "Lost",
  "Damaged",
  "Cancelled",
  "ReturnedToMerchant",
];

export function boardRank(status: string): number {
  const i = BOARD_ORDER.indexOf(status);
  return i === -1 ? BOARD_ORDER.length : i;
}

/** An exception is anything a dispatcher has to chase. */
export function isException(status: string): boolean {
  const g = statusGroup(status);
  return g === "warn" || g === "bad";
}
