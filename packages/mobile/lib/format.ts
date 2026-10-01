/**
 * Formatting rules are fixed by design.md and are not per-screen choices. This
 * is a deliberate mirror of the web portal's `lib/format.ts` — the same parcel
 * seen by a rider and by a dispatcher must read identically, or a phone call
 * between them turns into a translation exercise.
 *
 *   money  Rs. 1,250.00   (integer cents in, never a float anywhere)
 *   dates  DD/MM/YYYY
 *   time   Asia/Colombo — a raw UTC string is never shown in the UI
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

/** "4m ago" / "2h ago"; falls back to the full stamp. */
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
  // en-CA already yields YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: COLOMBO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function grams(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kg` : `${value} g`;
}

/** Turns PascalCase and snake_case into readable words. */
export function humanise(value: string | null | undefined): string {
  if (!value) return "—";
  const spaced = value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** "3 parcels" / "1 parcel" — plural agreement without a library. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Normalises a typed or scanned AWB the way the API does before comparing it
 * (`collection.scanItem` trims and upper-cases). Doing it client-side too means
 * the on-screen list matches what the server will accept.
 */
export function normaliseAwb(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * MONEY: rupees typed by a rider → integer cents, without ever touching a
 * float. "2,500" → 250000, "2500.5" → 250050, "2500.505" → null (no half
 * cents), "" → null. Commas and a leading "Rs." are tolerated because that is
 * how the amount is printed on the label.
 */
export function parseRupeesToCents(raw: string): number | null {
  const text = raw.replace(/^\s*rs\.?\s*/i, "").replace(/[,\s]/g, "");
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(text);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = (m[2] ?? "").padEnd(2, "0");
  return whole * 100 + Number(frac);
}
