/**
 * Money is ALWAYS an integer number of cents (PROJECT.md §9).
 * "Never use float or double for money." No function here returns a float.
 */

export const CURRENCY = "LKR";

/** 1250_00 → "Rs. 1,250.00" */
export function formatLkr(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  const grouped = rupees.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}Rs. ${grouped}.${paise.toString().padStart(2, "0")}`;
}

/** "1250.50" | 1250.5 → 125050 cents. Parsing is the only place a decimal is allowed. */
export function toCents(input: string | number): number {
  const n = typeof input === "number" ? input : Number.parseFloat(input);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
