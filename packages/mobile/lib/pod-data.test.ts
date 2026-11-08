import { describe, expect, test } from "bun:test";
import { receiverNicLast4 } from "./pod-data";

describe("receiver NIC masking", () => {
  test("returns only the final four digits for a modern NIC", () => {
    expect(receiverNicLast4("200012345678")).toBe("5678");
  });

  test("returns only the final four digits for a legacy NIC", () => {
    expect(receiverNicLast4("123456789v")).toBe("6789");
  });

  test("rejects incomplete or malformed NICs", () => {
    expect(receiverNicLast4("12345678")).toBeNull();
    expect(receiverNicLast4("123456789Q")).toBeNull();
    expect(receiverNicLast4("20001234567x")).toBeNull();
  });
});
