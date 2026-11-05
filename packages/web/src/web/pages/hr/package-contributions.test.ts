import { describe, expect, test } from "bun:test";
import { calculatePackageContributionEstimate, type PackageContributionInput } from "./package-contributions";

const baseInput = (overrides: Partial<PackageContributionInput> = {}): PackageContributionInput => ({
  payBasis: "monthly",
  basePayCents: 100_000,
  baseEpfEligible: true,
  baseEtfEligible: true,
  components: [],
  ...overrides,
});

describe("salary package contribution estimates", () => {
  test("uses eligible earnings for each statutory base and excludes deductions from gross and bases", () => {
    const estimate = calculatePackageContributionEstimate(baseInput({
      components: [
        { kind: "earning", amountCents: 250_000, epfEligible: true, etfEligible: true },
        { kind: "earning", amountCents: 50_000, epfEligible: false, etfEligible: false },
        { kind: "deduction", amountCents: 40_000, epfEligible: false, etfEligible: false },
      ],
    }));

    expect(estimate).toEqual({
      grossCents: 400_000,
      employeeEpfCents: 28_000,
      employerEpfCents: 42_000,
      employerEtfCents: 10_500,
      earningsAfterEmployeeEpfCents: 372_000,
      recurringEarningsCents: 300_000,
      recurringDeductionsCents: 40_000,
    });
  });

  test("returns zero contributions when base and component eligibility are off", () => {
    const estimate = calculatePackageContributionEstimate(baseInput({
      baseEpfEligible: false,
      baseEtfEligible: false,
      components: [{ kind: "earning", amountCents: 25_000, epfEligible: false, etfEligible: false }],
    }));
    expect(estimate).toMatchObject({
      grossCents: 125_000,
      employeeEpfCents: 0,
      employerEpfCents: 0,
      employerEtfCents: 0,
      earningsAfterEmployeeEpfCents: 125_000,
    });
  });

  test.each(["daily", "hourly"] as const)("keeps %s estimates base-only and reports fixed items separately", (payBasis) => {
    const estimate = calculatePackageContributionEstimate(baseInput({
      payBasis,
      basePayCents: 9_999,
      components: [
        { kind: "earning", amountCents: 12_000, epfEligible: true, etfEligible: true },
        { kind: "deduction", amountCents: 2_000, epfEligible: false, etfEligible: false },
      ],
    }));
    expect(estimate).toEqual({
      grossCents: 9_999,
      employeeEpfCents: 800,
      employerEpfCents: 1_200,
      employerEtfCents: 300,
      earningsAfterEmployeeEpfCents: 9_199,
      recurringEarningsCents: 12_000,
      recurringDeductionsCents: 2_000,
    });
  });

  test("uses half-up cent rounding", () => {
    const estimate = calculatePackageContributionEstimate(baseInput({
      basePayCents: 50,
      baseEpfEligible: false,
      baseEtfEligible: true,
    }));
    expect(estimate?.employerEtfCents).toBe(2); // 3% of 50 cents is 1.5 cents.
  });

  test.each([
    ["missing base", baseInput({ basePayCents: null })],
    ["fractional cents", baseInput({ basePayCents: 100_000.5 })],
    ["zero base", baseInput({ basePayCents: 0 })],
    ["missing component amount", baseInput({ components: [{ kind: "earning", amountCents: null, epfEligible: true, etfEligible: true }] })],
    ["negative component amount", baseInput({ components: [{ kind: "earning", amountCents: -1, epfEligible: true, etfEligible: true }] })],
    ["fractional component cents", baseInput({ components: [{ kind: "earning", amountCents: 1.5, epfEligible: true, etfEligible: true }] })],
  ])("returns unavailable for %s", (_description, input) => {
    expect(calculatePackageContributionEstimate(input)).toBeNull();
  });
});
