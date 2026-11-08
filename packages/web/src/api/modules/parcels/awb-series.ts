export const AWB_LABELS_PER_BATCH = 1_000;
export const AWB_PREFIX = "NX";
export const MIN_AWB_NUMBER = 1_000_000_000n;
export const MAX_AWB_NUMBER = 9_999_999_999n;

/** Keep one generation bounded so an admin request cannot allocate unbounded rows. */
export const MAX_LABELS_PER_GENERATION = 50_000;
export const MAX_NUMBERS_PER_BATCH = MAX_LABELS_PER_GENERATION;

export type PlannedAwbRange = {
  awbStart: string;
  awbEnd: string;
  labels: string[];
};

/** Convert an explicit NX tracking number or its ten-digit suffix to a number. */
export function awbNumber(value: string): bigint {
  const normalized = value.trim().toUpperCase();
  const suffix = normalized.startsWith(AWB_PREFIX) ? normalized.slice(AWB_PREFIX.length) : normalized;
  if (!/^\d{10}$/.test(suffix)) throw new RangeError("The tracking number start number must be exactly 10 digits, with the NX prefix.");
  const number = BigInt(suffix);
  if (number < MIN_AWB_NUMBER || number > MAX_AWB_NUMBER) {
    throw new RangeError("The tracking number must stay within the 10-digit NX number range.");
  }
  return number;
}

/** Produce an inclusive, zero-padded NX tracking number series without crossing 10 digits. */
export function createAwbSeries(startNumber: string, count = AWB_LABELS_PER_BATCH): string[] {
  if (!/^\d{10}$/.test(startNumber)) throw new RangeError("The tracking number start number must be exactly 10 digits.");
  if (!Number.isInteger(count) || count < 1) throw new RangeError("The tracking number series size must be a positive integer.");
  const start = awbNumber(startNumber);
  const end = start + BigInt(count) - 1n;
  if (end > MAX_AWB_NUMBER) {
    throw new RangeError("The tracking number series must stay within the 10-digit NX number range.");
  }
  return Array.from({ length: count }, (_, index) => `${AWB_PREFIX}${String(start + BigInt(index)).padStart(10, "0")}`);
}

/** Plan contiguous, non-overlapping ranges for an explicit multi-batch request. */
export function planAwbBatchRanges(
  batchCount: number,
  numbersPerBatch: number,
  startingTrackingNumber: string,
): PlannedAwbRange[] {
  if (!Number.isInteger(batchCount) || batchCount < 1) throw new RangeError("The number of batches must be a positive integer.");
  if (!Number.isInteger(numbersPerBatch) || numbersPerBatch < 1) throw new RangeError("The numbers per batch must be a positive integer.");
  if (batchCount > MAX_LABELS_PER_GENERATION || batchCount * numbersPerBatch > MAX_LABELS_PER_GENERATION) {
    throw new RangeError(`A generation may reserve at most ${MAX_LABELS_PER_GENERATION.toLocaleString()} tracking numbers.`);
  }

  const first = awbNumber(startingTrackingNumber);
  const ranges: PlannedAwbRange[] = [];
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const batchStart = first + BigInt(batchIndex * numbersPerBatch);
    const labels = createAwbSeries(String(batchStart).padStart(10, "0"), numbersPerBatch);
    ranges.push({ awbStart: labels[0]!, awbEnd: labels.at(-1)!, labels });
  }
  return ranges;
}

/** Choose a start that leaves room for a complete fixed-size label batch. */
export function randomAwbSeriesStart(count = AWB_LABELS_PER_BATCH): string {
  if (!Number.isInteger(count) || count < 1 || BigInt(count) > MAX_AWB_NUMBER - MIN_AWB_NUMBER + 1n) {
    throw new RangeError("The tracking number series size is outside the 10-digit NX number range.");
  }
  const min = Number(MIN_AWB_NUMBER);
  const max = Number(MAX_AWB_NUMBER - BigInt(count) + 1n);
  return String(Math.floor(Math.random() * (max - min + 1)) + min).padStart(10, "0");
}
