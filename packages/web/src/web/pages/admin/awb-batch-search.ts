const AWB_PREFIX = "NX";
const AWB_DIGITS = 10;

/**
 * Match a full AWB or a numeric prefix against a contiguous, fixed-width AWB range.
 * This lets a search find a batch even when the searched AWB is not one of its endpoints.
 */
export function awbRangeMatchesQuery(query: string, awbStart: string, awbEnd: string): boolean {
  const normalized = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digits = normalized.startsWith(AWB_PREFIX) ? normalized.slice(AWB_PREFIX.length) : normalized;
  if (!/^\d{1,10}$/.test(digits)) return false;

  const lowestAwb = `${AWB_PREFIX}${digits.padEnd(AWB_DIGITS, "0")}`;
  const highestAwb = `${AWB_PREFIX}${digits.padEnd(AWB_DIGITS, "9")}`;
  return lowestAwb <= awbEnd && highestAwb >= awbStart;
}
