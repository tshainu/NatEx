import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { Payslip } from "./payslip";
import type { PayrollLine } from "./payroll-presentation";

const line: PayrollLine = {
  id: "line_fixture", employeeId: "employee_fixture", employeeCode: "N26002",
  employeeName: "Payroll display fixture", payBasis: "monthly",
  grossCents: 5_000_000, epfBaseCents: 5_000_000, etfBaseCents: 5_000_000, apitBaseCents: 5_000_000,
  employeeEpfCents: 400_000, employerEpfCents: 600_000, employerEtfCents: 150_000,
  apitCents: 50_000, otherDeductionsCents: 100_000, netCents: 4_450_000,
  breakdownJson: JSON.stringify({
    warnings: [], overtimeCents: 0, apitScheduleVersion: "stored-fixture-schedule",
    lines: [{ label: "Base pay", kind: "earning", amountCents: 5_000_000 }, { label: "Loan repayment", kind: "deduction", amountCents: 100_000 }],
  }),
};

function render(status = "approved", values = line) {
  return new JSDOM(renderToStaticMarkup(<Payslip line={values} status={status} periodStart="2026-11-01" periodEnd="2026-11-30" />)).window.document;
}

function valueFor(document: Document, section: string, label: string) {
  const root = document.querySelector(`section[aria-label="${section}"]`)!;
  const term = Array.from(root.querySelectorAll("dt")).find(item => item.textContent === label);
  return term?.nextElementSibling?.textContent;
}

describe("printable payroll contribution display", () => {
  test("shows staff earnings after EPF and final net separately", () => {
    const doc = render();
    expect(valueFor(doc, "Employee pay summary", "Total earnings after staff EPF")).toBe("LKR 46000.00");
    expect(valueFor(doc, "Employee pay summary", "Net pay / take-home pay")).toBe("LKR 44500.00");
    expect(valueFor(doc, "Employee pay summary", "EPF staff deduction · 8%")).toBe("LKR 4000.00");
  });

  test("shows company EPF and ETF in a separate company-paid section", () => {
    const doc = render();
    expect(valueFor(doc, "Company-paid contributions", "EPF Company contribution · 12%")).toBe("LKR 6000.00");
    expect(valueFor(doc, "Company-paid contributions", "ETF Company contribution · 3%")).toBe("LKR 1500.00");
    expect(valueFor(doc, "Company-paid contributions", "Total Company contributions")).toBe("LKR 7500.00");
    expect(doc.querySelector('section[aria-label="Employee pay summary"]')?.textContent).not.toContain("Company contribution");
    expect(doc.querySelector('section[aria-label="Company-paid contributions"]')?.textContent).toContain("not deducted from or added to your net pay");
  });

  test("prints saved contribution and net amounts rather than applying current percentages again", () => {
    const doc = render("paid", { ...line, employerEpfCents: 599_999, netCents: 4_449_999 });
    expect(valueFor(doc, "Company-paid contributions", "EPF Company contribution · 12%")).toBe("LKR 5999.99");
    expect(valueFor(doc, "Employee pay summary", "Net pay / take-home pay")).toBe("LKR 44499.99");
    expect(doc.querySelector("header")?.textContent).toContain("Paid");
  });

  test("keeps draft/approved labelling and salary component deduction details", () => {
    const draft = render("draft");
    expect(draft.querySelector("header")?.textContent).toContain("DRAFT — not approved");
    expect(draft.querySelector("table")?.textContent).toContain("Loan repayment (deduction)");
    const approved = render();
    expect(approved.querySelector("header")?.textContent).toContain("Approved / ready for payment");
    expect(approved.querySelector("dialog")?.textContent).toContain("stored-fixture-schedule");
  });
});
