export type PayBasis = "monthly" | "daily" | "hourly";
export type OvertimePolicy = "none" | "shop_office" | "custom";
export type ComponentKind = "earning" | "deduction";

export interface SalaryComponent {
  label: string;
  kind: ComponentKind;
  amountCents: number;
  epfEligible: boolean;
  etfEligible: boolean;
  apitTaxable: boolean;
  overtimeEligible?: boolean;
  proration: "full_period" | "unpaid_leave_prorated";
}

export interface ApitBand {
  /** Inclusive maximum monthly taxable income; null means no upper limit. */
  maxMonthlyCents: number | null;
  rateBps: number;
  offsetCents: number;
}

export interface ApitSchedule {
  id: string;
  taxYear: string;
  effectiveFrom: string;
  effectiveTo: string;
  bands: ApitBand[];
}

/**
 * Provisional monthly primary-employment bands for 2026/27. The 2026/27 IRD
 * Circular SEC/2026/E/05 examples are consistent with these annualized bands,
 * but the full 2026/27 Table 01 was not listed by IRD at the October 2026 source
 * check. Payroll approval is therefore blocked until Finance/Admin records the
 * required accountant validation for this schedule.
 */
export const APIT_2026_27_PROVISIONAL: ApitSchedule = {
  id: "lk-apit-2026-27-provisional-v1",
  taxYear: "2026/27",
  effectiveFrom: "2026-04-01",
  effectiveTo: "2027-03-31",
  bands: [
    { maxMonthlyCents: 15_000_000, rateBps: 0, offsetCents: 0 },
    { maxMonthlyCents: 23_333_300, rateBps: 600, offsetCents: 900_000 },
    { maxMonthlyCents: 27_500_000, rateBps: 1800, offsetCents: 3_700_000 },
    { maxMonthlyCents: 31_666_700, rateBps: 2400, offsetCents: 5_350_000 },
    { maxMonthlyCents: 35_833_300, rateBps: 3000, offsetCents: 7_250_000 },
    { maxMonthlyCents: null, rateBps: 3600, offsetCents: 9_400_000 },
  ],
};

/** Validate ascending taxable-income bands with exactly one open-ended final band. */
export function validateApitBands(bands: readonly ApitBand[]): string | null {
  if (bands.length === 0 || bands.length > 20) return "An APIT schedule must contain between 1 and 20 bands.";
  let previousMaximum = -1;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index]!;
    if (!Number.isSafeInteger(band.rateBps) || band.rateBps < 0 || band.rateBps > 10_000) return `APIT band ${index + 1} has an invalid rate.`;
    if (!Number.isSafeInteger(band.offsetCents) || band.offsetCents < 0) return `APIT band ${index + 1} has an invalid monthly offset.`;
    if (band.maxMonthlyCents === null) {
      if (index !== bands.length - 1) return "Only the final APIT band may have no upper limit.";
      continue;
    }
    if (!Number.isSafeInteger(band.maxMonthlyCents) || band.maxMonthlyCents < 0 || band.maxMonthlyCents <= previousMaximum) {
      return `APIT band ${index + 1} must have a strictly increasing non-negative income ceiling.`;
    }
    previousMaximum = band.maxMonthlyCents;
  }
  if (bands[bands.length - 1]!.maxMonthlyCents !== null) return "The final APIT band must be open-ended.";
  return null;
}

export interface PayrollCalculationInput {
  payBasis: PayBasis;
  basePayCents: number;
  baseEpfEligible: boolean;
  baseEtfEligible: boolean;
  baseApitTaxable: boolean;
  components: readonly SalaryComponent[];
  regularMinutes: number;
  overtimeMinutes: number;
  overtimeMinutesByWeek?: readonly number[];
  paidLeaveHalfDays: number;
  unpaidLeaveHalfDays: number;
  /** Total non-payable half-days, including unpaid leave and days outside employment. */
  payProrationHalfDays?: number;
  periodDays: number;
  overtimePolicy: OvertimePolicy;
  overtimeMultiplierBps: number;
  overtimeDivisorMinutes: number;
  primaryEmployment: boolean;
  automaticApitEligible?: boolean;
  apitSchedule: ApitSchedule;
  manualApitCents?: number;
}

export interface PayrollCalculation {
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
  overtimeCents: number;
  warnings: string[];
  lines: { label: string; kind: ComponentKind; amountCents: number }[];
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer.`);
}

export function roundDiv(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error("Payroll arithmetic exceeded its safe integer range.");
  }
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

export function calculateApit(monthlyTaxableCents: number, schedule: ApitSchedule): number {
  assertNonNegativeInteger(monthlyTaxableCents, "Monthly taxable income");
  const invalid = validateApitBands(schedule.bands);
  if (invalid) throw new Error(invalid);
  const band = schedule.bands.find((item) => item.maxMonthlyCents === null || monthlyTaxableCents <= item.maxMonthlyCents);
  if (!band) throw new Error("APIT schedule has no matching band.");
  return Math.max(0, roundDiv(monthlyTaxableCents * band.rateBps, 10_000) - band.offsetCents);
}

function prorateByUnpaidLeave(amountCents: number, unpaidHalfDays: number, periodDays: number): number {
  const periodHalfDays = periodDays * 2;
  return roundDiv(amountCents * Math.max(0, periodHalfDays - unpaidHalfDays), periodHalfDays);
}

export function calculatePayroll(input: PayrollCalculationInput): PayrollCalculation {
  for (const [value, name] of [
    [input.basePayCents, "Base pay"],
    [input.regularMinutes, "Regular minutes"],
    [input.overtimeMinutes, "Overtime minutes"],
    [input.paidLeaveHalfDays, "Paid leave half-days"],
    [input.unpaidLeaveHalfDays, "Unpaid leave half-days"],
    [input.payProrationHalfDays ?? input.unpaidLeaveHalfDays, "Pay proration half-days"],
    [input.periodDays, "Period days"],
    [input.overtimeMultiplierBps, "Overtime multiplier"],
    [input.overtimeDivisorMinutes, "Overtime divisor"],
  ] as const) assertNonNegativeInteger(value, name);
  if (input.periodDays === 0 || input.overtimeDivisorMinutes === 0) throw new Error("Period days and overtime divisor must be positive.");
  if (input.unpaidLeaveHalfDays > input.periodDays * 2) throw new Error("Unpaid leave exceeds the pay period.");
  const payProrationHalfDays = input.payProrationHalfDays ?? input.unpaidLeaveHalfDays;
  if (payProrationHalfDays > input.periodDays * 2) throw new Error("Pay proration exceeds the pay period.");

  const warnings: string[] = [];
  const lines: PayrollCalculation["lines"] = [];
  const paidLeaveMinutes = input.paidLeaveHalfDays * 240;
  const payableMinutes = input.regularMinutes + paidLeaveMinutes;
  let baseCents: number;
  let overtimeRateDivisor: number;

  if (input.payBasis === "monthly") {
    baseCents = prorateByUnpaidLeave(input.basePayCents, payProrationHalfDays, input.periodDays);
    overtimeRateDivisor = input.overtimeDivisorMinutes;
  } else if (input.payBasis === "daily") {
    baseCents = roundDiv(input.basePayCents * payableMinutes, 480);
    overtimeRateDivisor = 480;
  } else {
    baseCents = roundDiv(input.basePayCents * payableMinutes, 60);
    overtimeRateDivisor = 60;
  }

  lines.push({ label: "Base pay", kind: "earning", amountCents: baseCents });
  let grossCents = baseCents;
  let epfBaseCents = input.baseEpfEligible ? baseCents : 0;
  let etfBaseCents = input.baseEtfEligible ? baseCents : 0;
  let apitBaseCents = input.baseApitTaxable ? baseCents : 0;
  let overtimeBaseCents = input.basePayCents;
  let otherDeductionsCents = 0;

  for (const item of input.components) {
    assertNonNegativeInteger(item.amountCents, `Component ${item.label}`);
    const amountCents = item.proration === "unpaid_leave_prorated"
      ? prorateByUnpaidLeave(item.amountCents, payProrationHalfDays, input.periodDays)
      : item.amountCents;
    lines.push({ label: item.label, kind: item.kind, amountCents });
    if (item.kind === "deduction") {
      otherDeductionsCents += amountCents;
      continue;
    }
    grossCents += amountCents;
    if (item.epfEligible) epfBaseCents += amountCents;
    if (item.etfEligible) etfBaseCents += amountCents;
    if (item.apitTaxable) apitBaseCents += amountCents;
    if (item.overtimeEligible) overtimeBaseCents += amountCents;
  }

  let overtimeCents = 0;
  if (input.overtimeMinutes > 0 && input.overtimePolicy === "none") {
    warnings.push("Overtime hours are recorded but this employee has no overtime-pay rule; configure one before finalizing.");
  } else if (input.overtimeMinutes > 0) {
    const overtimeRateBase = input.payBasis === "monthly" ? overtimeBaseCents : input.basePayCents;
    overtimeCents = roundDiv(overtimeRateBase * input.overtimeMinutes * input.overtimeMultiplierBps, overtimeRateDivisor * 10_000);
    lines.push({ label: "Overtime", kind: "earning", amountCents: overtimeCents });
    grossCents += overtimeCents;
    // Overtime is treated as remuneration for contribution and regular-employment APIT bases.
    epfBaseCents += overtimeCents;
    etfBaseCents += overtimeCents;
    apitBaseCents += overtimeCents;
  }
  for (const minutes of input.overtimeMinutesByWeek ?? []) {
    assertNonNegativeInteger(minutes, "Weekly overtime minutes");
    if (input.overtimePolicy === "shop_office" && minutes > 12 * 60) {
      warnings.push("Recorded overtime exceeds the 12-hour weekly Shop and Office limit; review the employee classification and work records.");
    }
  }

  const employeeEpfCents = roundDiv(epfBaseCents * 800, 10_000);
  const employerEpfCents = roundDiv(epfBaseCents * 1200, 10_000);
  const employerEtfCents = roundDiv(etfBaseCents * 300, 10_000);
  const automaticApitEligible = input.automaticApitEligible ?? true;
  const apitCents = input.manualApitCents ?? (input.primaryEmployment && automaticApitEligible ? calculateApit(apitBaseCents, input.apitSchedule) : 0);
  assertNonNegativeInteger(apitCents, "APIT");
  if (!input.primaryEmployment && input.manualApitCents === undefined) {
    warnings.push("Automatic APIT is configured for primary employment only; enter a reviewed APIT amount for secondary employment.");
  }
  if (input.primaryEmployment && !automaticApitEligible && input.manualApitCents === undefined) {
    warnings.push("Automatic monthly APIT was not applied for this non-standard pay period; enter the accountant-reviewed APIT amount.");
  }
  if (input.manualApitCents !== undefined) warnings.push("APIT was manually overridden; retain the supporting calculation or instruction.");

  const netCents = grossCents - employeeEpfCents - apitCents - otherDeductionsCents;
  if (!Number.isSafeInteger(netCents)) throw new Error("Net pay exceeded the safe integer range.");
  return {
    grossCents,
    epfBaseCents,
    etfBaseCents,
    apitBaseCents,
    employeeEpfCents,
    employerEpfCents,
    employerEtfCents,
    apitCents,
    otherDeductionsCents,
    netCents,
    overtimeCents,
    warnings: [...new Set(warnings)],
    lines,
  };
}
