import { describe, expect, test } from "bun:test";
import { MFA_ROLES, mfaRequiredFor, mfaRequiredForAny } from "./mfa";

describe("HR authenticator policy", () => {
  test("HR always requires MFA regardless of global settings or other roles", async () => {
    expect(MFA_ROLES).toContain("hr");
    expect(await mfaRequiredFor("hr")).toBe(true);
    expect(await mfaRequiredForAny(["rider", "hr"])).toBe(true);
  });
});
