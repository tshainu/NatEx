import { describe, expect, test } from "bun:test";
import { APIT_2026_27_PROVISIONAL, calculateApit, calculatePayroll, validateApitBands } from "./calculations";

const monthly = {
  payBasis: "monthly" as const,
  basePayCents: 25_000_000,
  baseEpfEligible: true,
  baseEtfEligible: true,
  baseApitTaxable: true,
  components: [],
  regularMinutes: 0,
  overtimeMinutes: 0,
  paidLeaveHalfDays: 0,
  unpaidLeaveHalfDays: 0,
  periodDays: 30,
  overtimePolicy: "shop_office" as const,
  overtimeMultiplierBps: 15_000,
  overtimeDivisorMinutes: 14_400,
  primaryEmployment: true,
  apitSchedule: APIT_2026_27_PROVISIONAL,
};

describe("NatEx Sri Lankan payroll calculations", () => {
  test("uses the APIT Table 01 monthly bands represented by the provisional 2026/27 schedule", () => {
    expect(calculateApit(15_000_000, APIT_2026_27_PROVISIONAL)).toBe(0);
    expect(calculateApit(20_000_000, APIT_2026_27_PROVISIONAL)).toBe(300_000);
    expect(calculateApit(25_000_000, APIT_2026_27_PROVISIONAL)).toBe(800_000);
    expect(calculateApit(32_500_000, APIT_2026_27_PROVISIONAL)).toBe(2_500_000);
    expect(calculateApit(39_000_000, APIT_2026_27_PROVISIONAL)).toBe(4_640_000);
  });

  test("validates editable APIT bands before accountant sign-off", () => {
    expect(validateApitBands(APIT_2026_27_PROVISIONAL.bands)).toBeNull();
    expect(validateApitBands([
      { maxMonthlyCents: 20_000_000, rateBps: 600, offsetCents: 0 },
      { maxMonthlyCents: 19_000_000, rateBps: 1_800, offsetCents: 100 },
      { maxMonthlyCents: null, rateBps: 2_400, offsetCents: 200 },
    ])).toMatch(/strictly increasing/);
    expect(validateApitBands([{ maxMonthlyCents: 20_000_000, rateBps: 600, offsetCents: 0 }])).toMatch(/open-ended/);
  });

  test("calculates employee EPF, employer EPF and employer-only ETF independently", () => {
    const result = calculatePayroll(monthly);
    expect(result.employeeEpfCents).toBe(2_000_000);
    expect(result.employerEpfCents).toBe(3_000_000);
    expect(result.employerEtfCents).toBe(750_000);
    expect(result.netCents).toBe(22_200_000);
  });

  test("excludes a non-contributory fixed deduction from gross and statutory bases", () => {
    const result = calculatePayroll({
      ...monthly,
      components: [{
        label: "Loan repayment",
        kind: "deduction",
        amountCents: 250_000,
        epfEligible: false,
        etfEligible: false,
        apitTaxable: false,
        overtimeEligible: false,
        proration: "full_period",
      }],
    });
    expect(result.grossCents).toBe(25_000_000);
    expect(result.otherDeductionsCents).toBe(250_000);
    expect(result.employeeEpfCents).toBe(2_000_000);
    expect(result.netCents).toBe(21_950_000);
  });

  test("prorates monthly base and package lines for unpaid leave without floating-point money", () => {
    const result = calculatePayroll({
      ...monthly,
      unpaidLeaveHalfDays: 2,
      components: [{
        label: "Attendance allowance",
        kind: "earning",
        amountCents: 3_000_000,
        epfEligible: true,
        etfEligible: true,
        apitTaxable: true,
        overtimeEligible: false,
        proration: "unpaid_leave_prorated",
      }],
    });
    expect(result.grossCents).toBe(27_066_667);
    expect(result.epfBaseCents).toBe(result.grossCents);
  });

  test("computes shop-office overtime from monthly pay divided by the statutory hourly divisor", () => {
    const result = calculatePayroll({ ...monthly, overtimeMinutes: 60 });
    expect(result.overtimeCents).toBe(156_250);
    expect(result.grossCents).toBe(25_156_250);
  });

  test("flags unconfigured or excess overtime instead of silently ignoring it", () => {
    const missing = calculatePayroll({ ...monthly, overtimePolicy: "none", overtimeMinutes: 60 });
    expect(missing.warnings[0]).toMatch(/no overtime-pay rule/);
    const excess = calculatePayroll({ ...monthly, overtimeMinutesByWeek: [13 * 60] });
    expect(excess.warnings[0]).toMatch(/12-hour weekly/);
  });

  test("requires reviewed APIT for a partial-month or non-primary employment case", () => {
    const partial = calculatePayroll({ ...monthly, payProrationHalfDays: 30, automaticApitEligible: false });
    expect(partial.apitCents).toBe(0);
    expect(partial.warnings.some((warning) => warning.includes("non-standard pay period"))).toBe(true);
    const manual = calculatePayroll({ ...monthly, payProrationHalfDays: 30, automaticApitEligible: false, manualApitCents: 200_000 });
    expect(manual.apitCents).toBe(200_000);
  });
});
