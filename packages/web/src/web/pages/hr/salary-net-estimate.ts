import {
  calculatePayroll,
  type ApitBand,
  type ApitSchedule,
  type SalaryComponent,
} from "../../../api/modules/hr/calculations";

export interface SalaryPackageNetEstimateInput {
  payBasis: string;
  basePayCents: number;
  baseEpfEligible: boolean;
  baseEtfEligible: boolean;
  baseApitTaxable: boolean;
  items: readonly {
    label: string;
    kind: string;
    amountCents: number;
    epfEligible: boolean;
    etfEligible: boolean;
    apitTaxable: boolean;
    overtimeEligible?: boolean;
    proration: string;
  }[];
}

export interface ApitScheduleForSalaryEstimate {
  id: string;
  taxYear: string;
  effectiveFrom: string;
  effectiveTo: string;
  scheduleJson: string;
}

/** Estimate one full monthly payroll with no leave or overtime, using payroll's own calculation rules. */
export function estimateMonthlyPackageNetCents(
  pkg: SalaryPackageNetEstimateInput,
  primaryEmployment: boolean,
  scheduleRow?: ApitScheduleForSalaryEstimate,
): number | null {
  if (pkg.payBasis !== "monthly" || !scheduleRow) return null;

  try {
    const bands = JSON.parse(scheduleRow.scheduleJson) as ApitBand[];
    const apitSchedule: ApitSchedule = {
      id: scheduleRow.id,
      taxYear: scheduleRow.taxYear,
      effectiveFrom: scheduleRow.effectiveFrom,
      effectiveTo: scheduleRow.effectiveTo,
      bands,
    };
    const components: SalaryComponent[] = pkg.items.map((item) => {
      if ((item.kind !== "earning" && item.kind !== "deduction") ||
          (item.proration !== "full_period" && item.proration !== "unpaid_leave_prorated")) {
        throw new Error("Invalid salary-package component.");
      }
      return {
        label: item.label,
        kind: item.kind,
        amountCents: item.amountCents,
        epfEligible: item.epfEligible,
        etfEligible: item.etfEligible,
        apitTaxable: item.apitTaxable,
        overtimeEligible: item.overtimeEligible,
        proration: item.proration,
      };
    });

    return calculatePayroll({
      payBasis: "monthly",
      basePayCents: pkg.basePayCents,
      baseEpfEligible: pkg.baseEpfEligible,
      baseEtfEligible: pkg.baseEtfEligible,
      baseApitTaxable: pkg.baseApitTaxable,
      components,
      regularMinutes: 0,
      overtimeMinutes: 0,
      paidLeaveHalfDays: 0,
      unpaidLeaveHalfDays: 0,
      payProrationHalfDays: 0,
      periodDays: 30,
      overtimePolicy: "none",
      overtimeMultiplierBps: 15_000,
      overtimeDivisorMinutes: 14_400,
      primaryEmployment,
      automaticApitEligible: primaryEmployment,
      apitSchedule,
    }).netCents;
  } catch {
    return null;
  }
}

export function salaryPackageNetOptionSuffix(
  pkg: SalaryPackageNetEstimateInput,
  primaryEmployment: boolean,
  scheduleRow: ApitScheduleForSalaryEstimate | undefined,
  formatLkr: (cents: number) => string,
): string {
  if (pkg.payBasis !== "monthly") return "(net varies with hours/days worked)";
  const netCents = estimateMonthlyPackageNetCents(pkg, primaryEmployment, scheduleRow);
  if (netCents === null) return "(net estimate unavailable)";
  const qualifier = primaryEmployment ? "" : " before manual APIT";
  return `(est. net LKR ${formatLkr(netCents)}${qualifier})`;
}
