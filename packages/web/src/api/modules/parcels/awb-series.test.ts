import { describe, expect, test } from "bun:test";
import { AWB_LABELS_PER_BATCH, createAwbSeries, planAwbBatchRanges, randomAwbSeriesStart } from "./awb-series";

describe("tracking number label series", () => {
  test("creates exactly 1,000 consecutive, zero-padded NX numbers", () => {
    const series = createAwbSeries("4820000000");
    expect(series).toHaveLength(AWB_LABELS_PER_BATCH);
    expect(series[0]).toBe("NX4820000000");
    expect(series[999]).toBe("NX4820000999");
    expect(new Set(series).size).toBe(AWB_LABELS_PER_BATCH);
  });

  test("permits the final 1,000-number block without overflowing 10 digits", () => {
    const series = createAwbSeries("9999999000");
    expect(series[0]).toBe("NX9999999000");
    expect(series.at(-1)).toBe("NX9999999999");
  });

  test("rejects malformed or overflowing ranges", () => {
    expect(() => createAwbSeries("123" )).toThrow(RangeError);
    expect(() => createAwbSeries("9999999001")).toThrow(RangeError);
  });

  test("chooses valid starts for full batches", () => {
    for (let i = 0; i < 100; i += 1) {
      const start = randomAwbSeriesStart();
      expect(createAwbSeries(start)).toHaveLength(1_000);
    }
  });

  test("plans sequential batches from the explicit starting tracking number", () => {
    const ranges = planAwbBatchRanges(3, 3, "NX4820000000");
    expect(ranges.map(({ awbStart, awbEnd }) => [awbStart, awbEnd])).toEqual([
      ["NX4820000000", "NX4820000002"],
      ["NX4820000003", "NX4820000005"],
      ["NX4820000006", "NX4820000008"],
    ]);
    const labels = ranges.flatMap((range) => range.labels);
    expect(new Set(labels).size).toBe(9);
    expect(labels).toEqual(createAwbSeries("4820000000", 9));
  });

  test("rejects invalid counts and a request that rolls past ten digits", () => {
    expect(() => planAwbBatchRanges(0, 1, "NX4820000000")).toThrow(RangeError);
    expect(() => planAwbBatchRanges(1, 0, "NX4820000000")).toThrow(RangeError);
    expect(() => planAwbBatchRanges(1.5, 1, "NX4820000000")).toThrow(RangeError);
    expect(() => planAwbBatchRanges(2, 1, "NX9999999999")).toThrow(RangeError);
    expect(() => planAwbBatchRanges(51, 1_000, "NX4820000000")).toThrow(RangeError);
  });
});
