import { describe, expect, test } from "bun:test";
import { nextEmployeeCode } from "./employee-number";

describe("automatic HR employee numbers", () => {
  test("reserves N26001 and starts at N26002 even when no N26 records exist", () => {
    expect(nextEmployeeCode([])).toBe("N26002");
    expect(nextEmployeeCode(["2055"])).toBe("N26002");
  });

  test("preserves historical numbers and advances after the greatest existing N26 number", () => {
    expect(nextEmployeeCode(["2055", "N26001"])).toBe("N26002");
    expect(nextEmployeeCode(["2055", "N26001", "N26002", "N26009"])).toBe("N26010");
  });

  test("ignores malformed and unrelated codes without reusing an existing sequence", () => {
    expect(nextEmployeeCode(["N26legacy", "N26003-old", "N26002", "n26004"])).toBe("N26005");
  });
});
