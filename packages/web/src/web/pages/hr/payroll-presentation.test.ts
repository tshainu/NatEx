import { describe, expect, test } from "bun:test";
import { payrollPaySummary } from "./payroll-presentation";

const amounts = {
  grossCents: 5_000_000,
  employeeEpfCents: 400_000,
  employerEpfCents: 600_000,
  employerEtfCents: 150_000,
  apitCents: 50_000,
  otherDeductionsCents: 100_000,
  netCents: 4_450_000,
};

describe("stored payroll pay presentation", () => {
  test("shows earnings after only staff EPF, before APIT and other deductions", () => {
    expect(payrollPaySummary(amounts)).toEqual({
      earningsAfterStaffEpfCents: 4_600_000,
      companyContributionsCents: 750_000,
      employeeDeductionsCents: 550_000,
      netCents: 4_450_000,
    });
  });

  test("company amounts do not add to or deduct from employee pay", () => {
    const changed = payrollPaySummary({ ...amounts, employerEpfCents: 1_200_000, employerEtfCents: 300_000 });
    expect(changed.earningsAfterStaffEpfCents).toBe(4_600_000);
    expect(changed.netCents).toBe(4_450_000);
    expect(changed.companyContributionsCents).toBe(1_500_000);
  });

  test("keeps saved net pay instead of recalculating historic approved snapshots", () => {
    expect(payrollPaySummary({ ...amounts, netCents: 4_449_999 }).netCents).toBe(4_449_999);
  });

  test("supports exempt contribution bases and exact fractional cents amounts", () => {
    const result = payrollPaySummary({ ...amounts, grossCents: 5_000_001, employeeEpfCents: 0, employerEpfCents: 0, employerEtfCents: 0 });
    expect(result.earningsAfterStaffEpfCents).toBe(5_000_001);
    expect(result.companyContributionsCents).toBe(0);
  });
});
