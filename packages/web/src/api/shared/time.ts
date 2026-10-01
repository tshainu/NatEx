/**
 * Time and calendar helpers.
 *
 * PROJECT.md §9: the whole system runs on Asia/Colombo. Dates are never UTC
 * calendar dates, display format is DD/MM/YYYY, and the week starts on Monday.
 * A "run date" or "pickup date" is a local calendar day, stored as text, because
 * a UTC instant cannot answer "which day's runsheet is this?" without a zone.
 */

export const TZ = "Asia/Colombo";

/** Asia/Colombo calendar date as YYYY-MM-DD. */
export function colomboToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Shift a YYYY-MM-DD calendar date by whole days, staying in Asia/Colombo. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  // Noon UTC keeps the arithmetic clear of both DST and the +05:30 offset.
  const base = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** DD/MM/YYYY — the only date format shown to a Sri Lankan user (§9). */
export function formatLkDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * ISO weekday of a calendar date: Monday = 1 … Sunday = 7.
 *
 * ISO numbering rather than JavaScript's Sunday-zero, because §9 says the week
 * starts on Monday and the settlement cut-off is configured as a weekday
 * number that a finance user has to be able to read.
 */
export function isoWeekday(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  const day = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 12, 0, 0)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The most recent date on or before `isoDate` that falls on `weekday`
 * (ISO numbering). Used to snap "today" back to the settlement cut-off —
 * Friday, per the client's answer to §15 q4.
 */
export function lastWeekdayOnOrBefore(isoDate: string, weekday: number): string {
  const back = (isoWeekday(isoDate) - weekday + 7) % 7;
  return back === 0 ? isoDate : addDays(isoDate, -back);
}

/** Hours from now, as a Date — used for SLA clocks. */
export function hoursFromNow(hours: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + hours * 3_600_000);
}
