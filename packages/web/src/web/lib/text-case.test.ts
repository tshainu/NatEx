import { describe, expect, test } from "bun:test";
import { shouldTitleCaseField, titleCaseText } from "./text-case";

describe("web form text casing", () => {
  test("capitalizes each ordinary word and lowercases the rest", () => {
    expect(titleCaseText("rOyAl FABRIC pvt ltd")).toBe("Royal Fabric Pvt Ltd");
    expect(titleCaseText("  no. 12, main road ")).toBe("  No. 12, Main Road ");
    expect(titleCaseText("ÉCOLE internationale")).toBe("École Internationale");
  });

  test("formats ordinary text inputs and long-form notes by default", () => {
    expect(shouldTitleCaseField({ type: "text", name: "merchantName" })).toBe(true);
    expect(shouldTitleCaseField({ type: "text", id: "contact-address" })).toBe(true);
    expect(shouldTitleCaseField({})).toBe(true);
  });

  test("preserves credentials, contact channels, codes, and case-sensitive identifiers", () => {
    for (const field of [
      { type: "password" },
      { type: "email" },
      { type: "tel" },
      { type: "search" },
      { name: "portalUsername" },
      { id: "trackingNumber" },
      { name: "employeeCode" },
      { name: "nationalId" },
      { autoComplete: "one-time-code" },
      { autoCapitalize: "none" },
      { caseFormat: "none" },
    ]) {
      expect(shouldTitleCaseField(field)).toBe(false);
    }
  });

  test("supports an explicit title-case override for a text field", () => {
    expect(shouldTitleCaseField({ type: "search", caseFormat: "title" })).toBe(true);
  });
});
