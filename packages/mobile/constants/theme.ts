import { Platform } from "react-native";

/**
 * NatEx field-app color tokens (design.md "Mobile (Expo)").
 *
 * The mobile app is **dark-first on purpose**: riders work outdoors in glare and
 * in apartment basements, and a white screen at 2pm in Colombo is unreadable.
 * So `light` and `dark` deliberately carry the same deep-ink values — the app
 * does not follow the system theme, because a courier app that turns white
 * mid-shift is a usability bug, not a feature.
 *
 * Token names mirror the web app's (`packages/web/src/web/styles.css`) so the
 * two platforms share one vocabulary, plus the five locked status tokens from
 * design.md that mean exactly the same thing in both places.
 */

/** The ink shell + amber accent from design.md "Colour". */
const ink = {
  ink900: "#0A1626",
  ink800: "#0F2033",
  ink700: "#16304A",
  ink600: "#1E4266",
  brand: "#F59E0B",
  brandInk: "#7C3E00",
  textHi: "#F4F7FB",
  textLo: "#8FA3B8",
} as const;

/**
 * Status palette — locked by design.md and used identically in web and mobile.
 * `statusColor()` below is the only thing that should map a parcel status to
 * one of these.
 */
const status = {
  /** Booked — created, not yet moving. */
  statusIdle: "#64748B",
  /** In custody and moving — PickedUp through OutForDelivery. */
  statusMoving: "#F59E0B",
  /** Terminal good — Delivered, RTODelivered. */
  statusGood: "#10B981",
  /** Needs attention — DeliveryAttempted, OnHold, RTO*. */
  statusWarn: "#F43F5E",
  /** Terminal bad — Lost, Damaged, Cancelled, ReturnedToMerchant. */
  statusBad: "#9F1239",
} as const;

const shell = {
  background: ink.ink900,
  foreground: ink.textHi,
  card: ink.ink700,
  cardForeground: ink.textHi,
  /** Raised-but-quieter surface: sheet headers, table header rows. */
  surface: ink.ink800,
  primary: ink.brand,
  primaryForeground: ink.brandInk,
  secondary: ink.ink800,
  secondaryForeground: ink.textHi,
  muted: ink.ink800,
  mutedForeground: ink.textLo,
  accent: ink.ink700,
  accentForeground: ink.textHi,
  border: ink.ink600,
  destructive: status.statusWarn,
  success: status.statusGood,
  warning: ink.brand,
  ...status,
} as const;

export const Colors = {
  light: shell,
  dark: shell,
} as const;

export type ColorScheme = keyof typeof Colors;
export type ThemeColors = (typeof Colors)[ColorScheme];

/**
 * Parcel status → status colour, per the locked table in design.md. Any status
 * the API adds later falls back to "moving" rather than rendering colourless,
 * because an unknown status on a parcel in custody is still a parcel in custody.
 */
const STATUS_GROUP: Record<string, keyof typeof status> = {
  Booked: "statusIdle",
  PickedUp: "statusMoving",
  AtOriginHub: "statusMoving",
  Bagged: "statusMoving",
  InTransit: "statusMoving",
  AtDestHub: "statusMoving",
  OutForDelivery: "statusMoving",
  Delivered: "statusGood",
  RTODelivered: "statusGood",
  DeliveryAttempted: "statusWarn",
  OnHold: "statusWarn",
  RTOInitiated: "statusWarn",
  RTOInTransit: "statusWarn",
  Lost: "statusBad",
  Damaged: "statusBad",
  Cancelled: "statusBad",
  ReturnedToMerchant: "statusBad",
};

export function statusColor(parcelStatus: string | null | undefined): string {
  if (!parcelStatus) return status.statusIdle;
  return status[STATUS_GROUP[parcelStatus] ?? "statusMoving"];
}

/**
 * Bag, trip and manifest lifecycles are not parcel statuses, but the operator
 * reads them with the same eyes — so they borrow the same five colours.
 */
const LIFECYCLE_GROUP: Record<string, keyof typeof status> = {
  open: "statusIdle",
  planned: "statusIdle",
  pending: "statusIdle",
  loading: "statusMoving",
  in_progress: "statusMoving",
  sealed: "statusMoving",
  in_transit: "statusMoving",
  departed: "statusMoving",
  arrived: "statusMoving",
  received: "statusGood",
  reconciled: "statusGood",
  handed_over: "statusGood",
  closed: "statusGood",
  cancelled: "statusBad",
};

export function lifecycleColor(value: string | null | undefined): string {
  if (!value) return status.statusIdle;
  return status[LIFECYCLE_GROUP[value] ?? "statusMoving"];
}

/**
 * Type scale from design.md. `mono` is **mandatory** for AWBs, seal numbers,
 * device ids and money — tabular figures are what make a mistyped digit
 * visible on a label scanned in a stairwell.
 */
export const Fonts = {
  display: "PlusJakartaSans_700Bold",
  displayMedium: "PlusJakartaSans_600SemiBold",
  body: "IBMPlexSans_400Regular",
  bodyMedium: "IBMPlexSans_500Medium",
  mono: "IBMPlexMono_500Medium",
  monoBold: "IBMPlexMono_600SemiBold",
} as const;

/** Nothing below 14px on mobile (design.md), except the 11px uppercase label. */
export const Type = {
  awb: 20,
  display: 24,
  title: 18,
  body: 15,
  small: 14,
  label: 11,
} as const;

/** 8px base grid, and the thumb-first sizes design.md pins down. */
export const Space = {
  unit: 8,
  page: 20,
  card: 16,
  /** Full-width primary action pinned to the bottom of the screen. */
  primaryButtonHeight: 56,
  /** Nothing tappable smaller than this. */
  minTouch: 48,
  radius: 12,
  radiusPill: 999,
} as const;

/** Kept for parity with the web template's platform font fallbacks. */
export const SystemFonts = Platform.select({
  ios: { mono: "ui-monospace" },
  default: { mono: "monospace" },
  web: { mono: "'IBM Plex Mono', 'SF Mono', monospace" },
});
