import { describe, expect, test } from "bun:test";
import { estimateMonthlyPackageNetCents, salaryPackageNetOptionSuffix } from "./salary-net-estimate";

const schedule = {
  id: "test-schedule",
  taxYear: "2026/27",
  effectiveFrom: "2026-04-01",
  effectiveTo: "2027-03-31",
  scheduleJson: JSON.stringify([{ maxMonthlyCents: null, rateBps: 1_000, offsetCents: 100_000 }]),
};

const monthlyPackage = {
  payBasis: "monthly",
  basePayCents: 10_000_000,
  baseEpfEligible: true,
  baseEtfEligible: true,
  baseApitTaxable: true,
  items: [
    { label: "Allowance", kind: "earning", amountCents: 2_000_000, epfEligible: true, etfEligible: true, apitTaxable: true, proration: "full_period" },
    { label: "Other deduction", kind: "deduction", amountCents: 500_000, epfEligible: false, etfEligible: false, apitTaxable: false, proration: "full_period" },
  ],
};

describe("salary package net estimates", () => {
  test("uses payroll's employee EPF, APIT and package deductions for primary employment", () => {
    expect(estimateMonthlyPackageNetCents(monthlyPackage, true, schedule)).toBe(9_440_000);
  });

  test("labels secondary-employment estimates as before manual APIT", () => {
    expect(estimateMonthlyPackageNetCents(monthlyPackage, false, schedule)).toBe(10_540_000);
    expect(salaryPackageNetOptionSuffix(monthlyPackage, false, schedule, (cents) => (cents / 100).toFixed(2)))
      .toBe("(est. net LKR 105400.00 before manual APIT)");
  });

  test("does not claim a fixed net for daily/hourly packages", () => {
    expect(estimateMonthlyPackageNetCents({ ...monthlyPackage, payBasis: "daily" }, true, schedule)).toBeNull();
    expect(salaryPackageNetOptionSuffix({ ...monthlyPackage, payBasis: "hourly" }, true, schedule, String))
      .toBe("(net varies with hours/days worked)");
  });

  test("reports no estimate if the APIT schedule is unavailable or invalid", () => {
    expect(estimateMonthlyPackageNetCents(monthlyPackage, true)).toBeNull();
    expect(estimateMonthlyPackageNetCents(monthlyPackage, true, { ...schedule, scheduleJson: "invalid" })).toBeNull();
  });
});
