import { describe, expect, test } from "bun:test";
import { navForRoles, rolesOfUser } from "./permissions";
import type { Role } from "./session";

function groupTitles(roles: readonly Role[]): string[] {
  return navForRoles(roles).map((group) => group.title);
}

function paths(roles: readonly Role[]): string[] {
  return navForRoles(roles).flatMap((group) => group.items.map((item) => item.to));
}

describe("department navigation", () => {
  test("HR users receive HR and Payroll menus", () => {
    expect(groupTitles(["hr"])).toEqual(["HR", "Payroll"]);
    expect(paths(["hr"])).toContain("/hr/dashboard");
    expect(paths(["hr"])).toContain("/hr/payroll");
    expect(paths(["hr"])).not.toContain("/admin/users");
  });

  test("HR plus Administration receives all three department menus", () => {
    expect(groupTitles(["hr", "admin"])).toEqual([
      "Overview",
      "Operations",
      "Transport",
      "Administration",
      "HR",
      "Payroll",
      "Finance",
      "Reports",
    ]);
    expect(paths(["hr", "admin"])).toContain("/admin/users");
    expect(paths(["hr", "admin"])).toContain("/hr/payroll");
  });

  test("primary role is retained if a stale session omits it from roles", () => {
    expect(rolesOfUser({ role: "admin", roles: ["hr"] })).toEqual(["admin", "hr"]);
    expect(groupTitles(rolesOfUser({ role: "admin", roles: ["hr"] }))).toContain("Administration");
    expect(groupTitles(rolesOfUser({ role: "admin", roles: ["hr"] }))).toContain("Payroll");
  });
});
