import { describe, expect, it } from "bun:test";
import {
  decodeRefreshSessionState,
  encodeRefreshSessionState,
  resolveMobileRole,
  resolveRequestedRole,
  type Role,
} from "./auth";

describe("resolveRequestedRole", () => {
  const assigned: Role[] = ["transport", "rider"];

  it("uses the primary role when no workspace is requested", () => {
    expect(resolveRequestedRole(null, assigned, "transport")).toBe("transport");
  });

  it("allows switching to another assigned role", () => {
    expect(resolveRequestedRole("rider", assigned, "transport")).toBe("rider");
  });

  it("rejects a role that the account does not hold", () => {
    expect(resolveRequestedRole("admin", assigned, "transport")).toBeNull();
  });

  it("rejects an unknown role name", () => {
    expect(resolveRequestedRole("collector", assigned, "transport")).toBeNull();
  });
});

describe("scoped mobile refresh state", () => {
  it("selects an assigned field role but never an unassigned desk role", () => {
    expect(resolveMobileRole(["ops", "rider"], "rider")).toBe("rider");
    expect(resolveMobileRole(["ops", "rider"], "ops")).toBeNull();
    expect(resolveMobileRole(["ops"])).toBeNull();
  });

  it("round-trips a rider field scope without exposing the account's desk roles", () => {
    const encoded = encodeRefreshSessionState("none", {
      kind: "mobile",
      role: "rider",
      mfaExempt: true,
    });
    expect(decodeRefreshSessionState(encoded)).toEqual({
      mfa: "none",
      scope: { kind: "mobile", role: "rider", mfaExempt: true },
    });
  });

  it("leaves a web MFA-verified session unchanged", () => {
    expect(encodeRefreshSessionState("verified")).toBe("verified");
    expect(decodeRefreshSessionState("verified")).toEqual({ mfa: "verified", scope: null });
    expect(decodeRefreshSessionState("challenge")).toEqual({ mfa: "challenge", scope: null });
  });

  it("does not decode arbitrary mobile roles", () => {
    expect(decodeRefreshSessionState("mobile:admin")).toEqual({ mfa: "none", scope: null });
  });
});
