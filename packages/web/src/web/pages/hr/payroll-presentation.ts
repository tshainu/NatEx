export interface PayrollLine {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  payBasis: string;
  grossCents: number;
  epfBaseCents: number;
  etfBaseCents: number;
  apitBaseCents: number;
  employeeEpfCents: number;
  employerEpfCents: number;
  employerEtfCents: number;
  apitCents: number;
  otherDeductionsCents: number;
  netCents: number;
  breakdownJson: string;
}

export interface PayrollSnapshot {
  warnings: string[];
  lines: { label: string; kind: "earning" | "deduction"; amountCents: number }[];
  overtimeCents: number;
  apitScheduleVersion: string;
  manualApitReason?: string;
}

type StoredPayAmounts = Pick<PayrollLine,
  "grossCents" | "employeeEpfCents" | "employerEpfCents" | "employerEtfCents" |
  "apitCents" | "otherDeductionsCents" | "netCents"
>;

/** Presentation only: never recalculate the saved statutory amounts or final net pay. */
export function payrollPaySummary(amounts: StoredPayAmounts) {
  return {
    earningsAfterStaffEpfCents: amounts.grossCents - amounts.employeeEpfCents,
    companyContributionsCents: amounts.employerEpfCents + amounts.employerEtfCents,
    employeeDeductionsCents: amounts.employeeEpfCents + amounts.apitCents + amounts.otherDeductionsCents,
    netCents: amounts.netCents,
  };
}
