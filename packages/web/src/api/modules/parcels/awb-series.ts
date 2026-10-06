export const AWB_LABELS_PER_BATCH = 1_000;
const AWB_PREFIX = "NX";
const MIN_AWB_NUMBER = 1_000_000_000n;
const MAX_AWB_NUMBER = 9_999_999_999n;

/** Produce an inclusive, zero-padded NX AWB series without crossing 10 digits. */
export function createAwbSeries(startNumber: string, count = AWB_LABELS_PER_BATCH): string[] {
  if (!/^\d{10}$/.test(startNumber)) throw new RangeError("The AWB start number must be exactly 10 digits.");
  if (!Number.isInteger(count) || count < 1) throw new RangeError("The AWB series size must be a positive integer.");
  const start = BigInt(startNumber);
  const end = start + BigInt(count) - 1n;
  if (start < MIN_AWB_NUMBER || end > MAX_AWB_NUMBER) {
    throw new RangeError("The AWB series must stay within the 10-digit NX number range.");
  }
  return Array.from({ length: count }, (_, index) => `${AWB_PREFIX}${String(start + BigInt(index)).padStart(10, "0")}`);
}

/** Choose a start that leaves room for a complete fixed-size label batch. */
export function randomAwbSeriesStart(): string {
  const min = Number(MIN_AWB_NUMBER);
  const max = Number(MAX_AWB_NUMBER - BigInt(AWB_LABELS_PER_BATCH) + 1n);
  return String(Math.floor(Math.random() * (max - min + 1)) + min).padStart(10, "0");
}
