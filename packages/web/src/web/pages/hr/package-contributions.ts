import { roundDiv } from "../../../api/modules/hr/calculations";

export type PackagePayBasis = "monthly" | "daily" | "hourly";
export type PackageComponentKind = "earning" | "deduction";

export interface PackageContributionInput {
  payBasis: PackagePayBasis;
  basePayCents: number | null;
  baseEpfEligible: boolean;
  baseEtfEligible: boolean;
  components: readonly {
    kind: PackageComponentKind;
    amountCents: number | null;
    epfEligible: boolean;
    etfEligible: boolean;
  }[];
}

export interface PackageContributionEstimate {
  /** Monthly: full-period earnings. Daily/hourly: base pay for one rate unit only. */
  grossCents: number;
  employeeEpfCents: number;
  employerEpfCents: number;
  employerEtfCents: number;
  /** Earnings less employee EPF only; APIT and other deductions are not subtracted. */
  earningsAfterEmployeeEpfCents: number;
  /** Recurring component totals are reported separately from daily/hourly rate estimates. */
  recurringEarningsCents: number;
  recurringDeductionsCents: number;
}

function addSafe(total: number, amount: number): number | null {
  const result = total + amount;
  return Number.isSafeInteger(result) ? result : null;
}

function validCents(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

/**
 * Estimate package contributions using the same 8%/12%/3% rates and half-up
 * cent rounding as payroll. A null result means the form is incomplete or
 * malformed; daily/hourly estimates intentionally exclude fixed period items.
 */
export function calculatePackageContributionEstimate(
  input: PackageContributionInput,
): PackageContributionEstimate | null {
  if (
    !input ||
    !["monthly", "daily", "hourly"].includes(input.payBasis) ||
    !validCents(input.basePayCents) ||
    typeof input.baseEpfEligible !== "boolean" ||
    typeof input.baseEtfEligible !== "boolean" ||
    !Array.isArray(input.components)
  ) return null;

  let recurringEarningsCents = 0;
  let recurringDeductionsCents = 0;
  let epfBaseCents = input.baseEpfEligible ? input.basePayCents : 0;
  let etfBaseCents = input.baseEtfEligible ? input.basePayCents : 0;

  for (const component of input.components) {
    if (
      !component ||
      (component.kind !== "earning" && component.kind !== "deduction") ||
      !validCents(component.amountCents) ||
      typeof component.epfEligible !== "boolean" ||
      typeof component.etfEligible !== "boolean"
    ) return null;

    if (component.kind === "deduction") {
      const next = addSafe(recurringDeductionsCents, component.amountCents);
      if (next === null) return null;
      recurringDeductionsCents = next;
      continue;
    }

    const next = addSafe(recurringEarningsCents, component.amountCents);
    if (next === null) return null;
    recurringEarningsCents = next;
    if (component.epfEligible) {
      const nextEpfBase = addSafe(epfBaseCents, component.amountCents);
      if (nextEpfBase === null) return null;
      epfBaseCents = nextEpfBase;
    }
    if (component.etfEligible) {
      const nextEtfBase = addSafe(etfBaseCents, component.amountCents);
      if (nextEtfBase === null) return null;
      etfBaseCents = nextEtfBase;
    }
  }

  const monthly = input.payBasis === "monthly";
  const grossCents = monthly
    ? addSafe(input.basePayCents, recurringEarningsCents)
    : input.basePayCents;
  if (grossCents === null) return null;

  if (!monthly) {
    epfBaseCents = input.baseEpfEligible ? input.basePayCents : 0;
    etfBaseCents = input.baseEtfEligible ? input.basePayCents : 0;
  }

  try {
    const employeeEpfCents = roundDiv(epfBaseCents * 800, 10_000);
    const employerEpfCents = roundDiv(epfBaseCents * 1200, 10_000);
    const employerEtfCents = roundDiv(etfBaseCents * 300, 10_000);
    const earningsAfterEmployeeEpfCents = grossCents - employeeEpfCents;
    if (!Number.isSafeInteger(earningsAfterEmployeeEpfCents)) return null;
    return {
      grossCents,
      employeeEpfCents,
      employerEpfCents,
      employerEtfCents,
      earningsAfterEmployeeEpfCents,
      recurringEarningsCents,
      recurringDeductionsCents,
    };
  } catch {
    return null;
  }
}
