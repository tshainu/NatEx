import type { Role } from "../../shared/auth";

/**
 * Parcel state machine (PROJECT.md §6).
 *
 * "Status is never a free-text column. It is an enumerated state advanced only
 *  through legal transitions, each recorded as a permanent parcel_event row."
 *
 * The full enum and transition table live here from M1 because a partial state
 * machine cannot be proven correct. Which transitions are *reachable through the
 * API* is a separate, narrower question — see M1_ENABLED below.
 */

export const PARCEL_STATUSES = [
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
] as const;

export type ParcelStatus = (typeof PARCEL_STATUSES)[number];

export const TERMINAL_STATUSES: readonly ParcelStatus[] = [
  "Delivered",
  "RTODelivered",
  "Lost",
  "Damaged",
  "Cancelled",
  "ReturnedToMerchant",
] as const;

/** Statuses that count as "in NatEx custody" for the ops board. */
export const IN_CUSTODY_STATUSES: readonly ParcelStatus[] = [
  "PickedUp",
  "AtOriginHub",
  "Bagged",
  "InTransit",
  "AtDestHub",
  "OutForDelivery",
] as const;

export const EXCEPTION_STATUSES: readonly ParcelStatus[] = [
  "DeliveryAttempted",
  "OnHold",
  "RTOInitiated",
  "RTOInTransit",
] as const;

/** Maximum delivery attempts before automatic RTO (PROJECT.md §6). */
export const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * The legal transition table. Anything absent here is rejected with 422.
 * Happy path:
 *   Booked → PickedUp → AtOriginHub → Bagged → InTransit → AtDestHub
 *          → OutForDelivery → Delivered
 * Exceptional:
 *   DeliveryAttempted → OnHold → RTOInitiated → RTOInTransit → RTODelivered
 */
export const TRANSITIONS: Readonly<Record<ParcelStatus, readonly ParcelStatus[]>> = {
  Booked: ["PickedUp", "Cancelled", "OnHold", "Lost"],
  PickedUp: ["AtOriginHub", "OnHold", "Lost", "Damaged"],
  AtOriginHub: ["Bagged", "OutForDelivery", "OnHold", "Lost", "Damaged"],
  Bagged: ["InTransit", "AtOriginHub", "OnHold", "Lost", "Damaged"],
  InTransit: ["AtDestHub", "OnHold", "Lost", "Damaged"],
  AtDestHub: ["OutForDelivery", "Bagged", "OnHold", "Lost", "Damaged"],
  OutForDelivery: ["Delivered", "DeliveryAttempted", "OnHold", "Lost", "Damaged"],
  DeliveryAttempted: ["OutForDelivery", "OnHold", "RTOInitiated", "Lost", "Damaged"],
  // OnHold → ReturnedToMerchant: the merchant collects a held parcel over the
  // hub counter, with no RTO trip. Without this edge ReturnedToMerchant was an
  // enabled status nothing could reach (caught by the §6 reachability test).
  OnHold: [
    "OutForDelivery",
    "AtDestHub",
    "RTOInitiated",
    "Cancelled",
    "Lost",
    "Damaged",
    "ReturnedToMerchant",
  ],
  RTOInitiated: ["RTOInTransit", "OnHold", "Lost", "Damaged"],
  RTOInTransit: ["RTODelivered", "OnHold", "Lost", "Damaged"],
  // Terminal states are immutable — "corrections are reversal events, never edits".
  Delivered: [],
  RTODelivered: [],
  Lost: [],
  Damaged: [],
  Cancelled: [],
  ReturnedToMerchant: [],
};

/**
 * Which role may command which transition.
 * "Each transition requires a role — a merchant cannot mark Delivered." (§6)
 */
export const TRANSITION_ROLES: Readonly<Record<ParcelStatus, readonly Role[]>> = {
  Booked: ["merchant", "ops", "admin"],
  PickedUp: ["rider", "ops", "admin"],
  AtOriginHub: ["rider", "transport", "ops", "admin"],
  Bagged: ["transport", "ops", "admin"],
  InTransit: ["transport", "ops", "admin"],
  AtDestHub: ["transport", "ops", "admin"],
  OutForDelivery: ["ops", "transport", "admin"],
  Delivered: ["rider", "ops", "admin"],
  DeliveryAttempted: ["rider", "ops", "admin"],
  OnHold: ["ops", "admin"],
  RTOInitiated: ["ops", "admin"],
  RTOInTransit: ["transport", "ops", "admin"],
  RTODelivered: ["rider", "ops", "admin"],
  Lost: ["ops", "admin"],
  Damaged: ["transport", "ops", "admin"],
  Cancelled: ["merchant", "ops", "admin"],
  ReturnedToMerchant: ["ops", "admin"],
};

/**
 * Which transitions the API actually exposes, per milestone (§10: "never
 * scaffold ahead"). The whole transition table above is unit-tested from M1,
 * but a status only becomes reachable through the API in the milestone that
 * owns the workflow producing it.
 *
 * Bump CURRENT_MILESTONE when a milestone is complete, running and verified —
 * not when its code is merely written.
 */
export const ENABLED_BY_MILESTONE: Readonly<Record<number, readonly ParcelStatus[]>> = {
  // M1 — Core & Collection: booking, pickup, origin-hub receipt.
  1: ["Booked", "PickedUp", "AtOriginHub", "OnHold", "Cancelled", "Lost", "Damaged"],
  // M2 — Transport & Custody: bagging, linehaul, destination-hub receipt.
  2: ["Bagged", "InTransit", "AtDestHub"],
  // M3 — Delivery & Merchant: runsheets, POD, failures, RTO.
  3: [
    "OutForDelivery",
    "Delivered",
    "DeliveryAttempted",
    "RTOInitiated",
    "RTOInTransit",
    "RTODelivered",
    "ReturnedToMerchant",
  ],
  // M4 — Money, M5 — Hardening: no new parcel statuses of their own.
  4: [],
  5: [],
};

/**
 * ONE FLAG WAS DOING TWO JOBS, AND SO WAS WRONG EITHER WAY.
 *
 * `CURRENT_MILESTONE` both (a) gated which statuses the API accepts and (b)
 * was reported to clients as "how far this build has got". Those are not the
 * same number right now: M3's *backend* is built and verified (runsheets, POD,
 * failures, RTO — 85 live checks), but M3's rider mobile screens and §7 offline
 * sync are NOT built. So 3 over-claimed progress, while dropping it to 2 would
 * have removed `Delivered` from the accepted-status enum — disabling the
 * verified delivery backend and, with it, every COD-on-delivery path M4 exists
 * to build. Hence two flags.
 */

/**
 * What the API exposes. A status is listed here once the server-side workflow
 * producing it is built, running and verified — regardless of which clients
 * can drive it yet.
 */
export const EXPOSED_MILESTONE = 4;

/**
 * What is actually shipped end-to-end, clients included. Lower than
 * EXPOSED_MILESTONE whenever a milestone's backend is proven but its UI is not.
 * M3 shipped 2026-10-01, every client proven against the live API and DB:
 * delivery engine (`scripts/smoke-m3.ts`), §7 offline sync (`smoke-sync.ts`,
 * `soak-sync.ts`, `probe-sync-conflicts.ts`), rider app (`ui-rider.ts`,
 * `ui-rider-queue.ts`, `probe-pod-photo.ts`; Expo web only, not yet on a
 * physical phone), ops runsheets + NDR (`probe-ops-delivery.ts`,
 * `ui-ops-delivery.ts`), merchant portal + bulk booking
 * (`probe-merchant-portal.ts`, `probe-bulk-booking.ts`, `ui-merchant.ts`) and
 * §6 transition unit tests (`state-machine.test.ts`, `transition.db.test.ts`).
 * M4 shipped 2026-10-02 (it adds no parcel statuses, so ENABLED_STATUSES did
 * not move): COD ledger, deposits, settlements with maker–checker, holds,
 * invoicing + credit notes, disputes, bank details and the payout file
 * (`smoke-m4.ts`, `probe-cod-wiring.ts`, `probe-disputes.ts`,
 * `probe-finance-pages.ts`, `probe-merchant-visibility.ts`), the finance portal
 * (`ui-finance.ts`) and the merchant statement (`ui-merchant.ts`). This is the
 * honest number to show a human.
 */
export const SHIPPED_MILESTONE = 4;

/** @deprecated Ambiguous. Read EXPOSED_MILESTONE or SHIPPED_MILESTONE. */
export const CURRENT_MILESTONE = EXPOSED_MILESTONE;

/** Statuses reachable through the API right now. */
export const ENABLED_STATUSES: readonly ParcelStatus[] = Object.entries(
  ENABLED_BY_MILESTONE,
)
  .filter(([milestone]) => Number(milestone) <= EXPOSED_MILESTONE)
  .flatMap(([, statuses]) => statuses);

/** Which milestone unlocks this status — used to explain a refusal. */
export function milestoneFor(to: ParcelStatus): number {
  for (const [milestone, statuses] of Object.entries(ENABLED_BY_MILESTONE)) {
    if (statuses.includes(to)) return Number(milestone);
  }
  return Number.MAX_SAFE_INTEGER;
}

export function isTerminal(status: ParcelStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function legalNext(status: ParcelStatus): readonly ParcelStatus[] {
  return TRANSITIONS[status] ?? [];
}

export function isLegalTransition(from: ParcelStatus, to: ParcelStatus): boolean {
  return legalNext(from).includes(to);
}

export function roleMayCommand(role: Role, to: ParcelStatus): boolean {
  return (TRANSITION_ROLES[to] ?? []).includes(role);
}

/** Is this transition exposed by the API in the current milestone? */
export function isEnabled(to: ParcelStatus): boolean {
  return ENABLED_STATUSES.includes(to);
}

/**
 * Does reaching `to` require proof of delivery? (§6: "Delivered requires POD".)
 * POD capture itself is M3; the rule is declared here so M3 cannot forget it.
 */
export function requiresPod(to: ParcelStatus): boolean {
  return to === "Delivered" || to === "RTODelivered";
}

/** §6: "Bagged → InTransit requires the bag to be sealed and assigned to a trip." */
export function requiresSealedBag(from: ParcelStatus, to: ParcelStatus): boolean {
  return from === "Bagged" && to === "InTransit";
}

/** §6: COD amount is locked once Delivered; only Finance may adjust, with audit. */
export function locksCod(to: ParcelStatus): boolean {
  return to === "Delivered";
}

/** §6: max 3 attempts, then automatic RTOInitiated. */
export function shouldAutoRto(attempts: number): boolean {
  return attempts >= MAX_DELIVERY_ATTEMPTS;
}
