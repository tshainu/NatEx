import { GROUP_COLOUR } from "./status";

/**
 * Chart colours. design.md: charts never invent a colour — every series is a
 * status-palette colour or a darker step of one, so "green" on a chart means
 * the same thing it means on a status pill.
 *
 *   parcel outcomes  booked = created slate, delivered = good emerald,
 *                    failed attempt = warn rose, RTO = bad wine
 *   COD checkpoints  cash moving through NatEx hands is sky (the "moving"
 *                    colour), and turns emerald as it reaches the merchant:
 *                    collected → deposited → banked → settled
 *   AR ageing        slate while not due, then sky → rose → wine as it ages
 */
export const SERIES = {
  booked: GROUP_COLOUR.created,
  delivered: GROUP_COLOUR.good,
  attempted: GROUP_COLOUR.warn,
  rto: GROUP_COLOUR.bad,
  open: GROUP_COLOUR.moving,
  closed: GROUP_COLOUR.good,

  collected: GROUP_COLOUR.moving,
  deposited: "#0369A1",
  banked: "#047857",
  settled: GROUP_COLOUR.good,

  notDue: GROUP_COLOUR.created,
  age0: GROUP_COLOUR.moving,
  age31: "#FB7185",
  age61: GROUP_COLOUR.warn,
  age90: GROUP_COLOUR.bad,
} as const;

/** "2026-10-03" → "03/10" — a chart axis has no room for the year (§9 order kept). */
export function dayTick(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${d}/${m}`;
}

/** "2026-10-03" → "Sat 03/10/2026" for a tooltip header. */
export function dayLong(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 12)).toLocaleDateString("en-GB", {
    weekday: "short",
    timeZone: "UTC",
  });
  return `${weekday} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

/** Axis label for integer cents: Rs. 950, Rs. 12.4k, Rs. 1.2M. */
export function moneyTick(cents: number): string {
  const rupees = cents / 100;
  const abs = Math.abs(rupees);
  if (abs >= 1_000_000) return `Rs. ${(rupees / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `Rs. ${(rupees / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `Rs. ${Math.round(rupees)}`;
}
