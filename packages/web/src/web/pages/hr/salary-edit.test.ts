import { describe, expect, test } from "bun:test";
import { lkrToCents } from "./shared";
import { salaryPackageAtDate, shouldAssignSalaryPackage, type SalaryAssignmentForEdit } from "./salary-edit";

const history: SalaryAssignmentForEdit[] = [
  { assignment: { packageId: "pkg-current", effectiveFrom: "2026-07-01", effectiveTo: null } },
  { assignment: { packageId: "pkg-old", effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" } },
];

describe("employee salary editing", () => {
  test("uses the package covering the requested effective date", () => {
    expect(salaryPackageAtDate(history, "2026-08-15")).toBe("pkg-current");
    expect(salaryPackageAtDate(history, "2026-06-30")).toBe("pkg-old");
    expect(salaryPackageAtDate(history, "2025-12-31")).toBeNull();
  });

  test("does not create a duplicate history row when the selected package is already in force", () => {
    expect(shouldAssignSalaryPackage(history, "pkg-current", "2026-11-08")).toBe(false);
    expect(shouldAssignSalaryPackage(history, "pkg-old", "2026-11-08")).toBe(true);
    expect(shouldAssignSalaryPackage(history, "pkg-current", "2026-06-30")).toBe(true);
  });

  test("preserves the HR money contract: input rupees become integer cents", () => {
    expect(lkrToCents("125000.50")).toBe(12_500_050);
    expect(lkrToCents("125000.5")).toBe(12_500_050);
    expect(lkrToCents("125000.005")).toBeNull();
    expect(lkrToCents("-1")).toBeNull();
  });
});
