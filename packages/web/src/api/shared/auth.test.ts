import { describe, expect, it } from "bun:test";
import { resolveRequestedRole, type Role } from "./auth";

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
