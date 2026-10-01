/**
 * Formatting rules are fixed by design.md and are not per-component choices:
 *   money  Rs. 1,250.00   (integer cents in, never a float anywhere)
 *   dates  DD/MM/YYYY
 *   time   Asia/Colombo — a raw UTC string is never shown in the UI
 *   weeks  start Monday
 */

const COLOMBO = "Asia/Colombo";

const moneyFormatter = new Intl.NumberFormat("en-LK", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** MONEY: takes integer cents. Passing a float here is a bug (§9). */
export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `Rs. ${moneyFormatter.format(cents / 100)}`;
}

/** Money without the currency prefix, for tight table columns. */
export function amount(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return moneyFormatter.format(cents / 100);
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dateParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: COLOMBO,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const timeParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: COLOMBO,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** DD/MM/YYYY in Asia/Colombo. */
export function date(value: Date | string | number | null | undefined): string {
  const d = toDate(value);
  return d ? dateParts.format(d) : "—";
}

/** DD/MM/YYYY HH:mm in Asia/Colombo. */
export function dateTime(value: Date | string | number | null | undefined): string {
  const d = toDate(value);
  return d ? `${dateParts.format(d)} ${timeParts.format(d)}` : "—";
}

/** HH:mm in Asia/Colombo — for a timeline where the day is already obvious. */
export function time(value: Date | string | number | null | undefined): string {
  const d = toDate(value);
  return d ? timeParts.format(d) : "—";
}

/** "4m ago" / "2h ago" for the live feed; falls back to the full stamp. */
export function since(value: Date | string | number | null | undefined): string {
  const d = toDate(value);
  if (!d) return "—";
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return dateTime(d);
}

/** Today in Asia/Colombo as YYYY-MM-DD — matches the API's pickupDate. */
export function colomboToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: COLOMBO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts; // en-CA already yields YYYY-MM-DD
}

/** Coordinates cross the API as integer microdegrees (shared/geo.ts). */
export function fromE6(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : value / 1e6;
}

export function toE6(value: number): number {
  return Math.round(value * 1e6);
}

export function coords(
  latE6: number | null | undefined,
  lngE6: number | null | undefined,
): string {
  const lat = fromE6(latE6);
  const lng = fromE6(lngE6);
  if (lat === null || lng === null) return "—";
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export function grams(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kg` : `${value} g`;
}

export function metres(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m`;
}

/** Turns PascalCase statuses into readable words: OutForDelivery → Out For Delivery. */
export function humanise(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}
