import { describe, expect, test } from "bun:test";
import { mayVisit, navFor, navForRoles, rolesOfUser } from "./permissions";
import type { Role } from "./session";

function groupTitles(roles: readonly Role[]): string[] {
  return navForRoles(roles).map((group) => group.title);
}

function paths(roles: readonly Role[]): string[] {
  return navForRoles(roles).flatMap((group) => group.items.map((item) => item.to));
}

function titlesForSelectedRole(role: Role): string[] {
  return navFor(role).map((group) => group.title);
}

describe("department navigation", () => {
  test("the selected HR role does not inherit secondary department menus", () => {
    expect(titlesForSelectedRole("hr")).toEqual(["HR & Payroll"]);
    expect(titlesForSelectedRole("hr")).not.toContain("Operations");
    expect(titlesForSelectedRole("hr")).not.toContain("Transport");
    expect(titlesForSelectedRole("hr")).not.toContain("Administration");
  });

  test("HR users receive one HR & Payroll menu", () => {
    expect(groupTitles(["hr"])).toEqual(["HR & Payroll"]);
    expect(paths(["hr"])).toContain("/hr/dashboard");
    expect(paths(["hr"])).toContain("/hr/payroll");
    expect(paths(["hr"])).not.toContain("/admin/users");
  });

  test("HR plus Administration receives all three department menus", () => {
    expect(groupTitles(["hr", "admin"])).toEqual([
      "Operations",
      "Transport",
      "Administration",
      "HR & Payroll",
      "Finance",
      "Reports",
    ]);
    expect(paths(["hr", "admin"])).toContain("/admin/users");
    expect(paths(["hr", "admin"])).toContain("/hr/payroll");
  });

  test("primary role is retained if a stale session omits it from roles", () => {
    expect(rolesOfUser({ role: "admin", roles: ["hr"] })).toEqual(["admin", "hr"]);
    expect(groupTitles(rolesOfUser({ role: "admin", roles: ["hr"] }))).toContain("Administration");
    expect(groupTitles(rolesOfUser({ role: "admin", roles: ["hr"] }))).toContain("HR & Payroll");
  });

  test("ultimate admins can open the operations parcel page", () => {
    expect(mayVisit("super_admin", "/ops/parcels")).toBe(true);
    expect(mayVisit("nos_admin", "/ops/parcels")).toBe(true);
  });
});
