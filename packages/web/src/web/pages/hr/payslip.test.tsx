import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { Payslip } from "./payslip";
import type { PayrollLine } from "./payroll-presentation";

const line: PayrollLine = {
  id: "line_fixture", employeeId: "employee_fixture", employeeCode: "N26002", employeeName: "Payroll display fixture", nationalId: "901234567V", payBasis: "monthly",
  grossCents: 5_000_000, epfBaseCents: 5_000_000, etfBaseCents: 5_000_000, apitBaseCents: 5_000_000,
  employeeEpfCents: 400_000, employerEpfCents: 600_000, employerEtfCents: 150_000,
  apitCents: 0, otherDeductionsCents: 100_000, netCents: 4_500_000,
  breakdownJson: JSON.stringify({
    warnings: [], overtimeCents: 0, apitScheduleVersion: "stored-fixture-schedule",
    lines: [{ label: "Base salary", kind: "earning", amountCents: 5_000_000 }, { label: "Loan repayment", kind: "deduction", amountCents: 100_000 }],
  }),
};

function render(values = line) {
  return new JSDOM(renderToStaticMarkup(<Payslip line={values} status="approved" periodStart="2026-11-01" periodEnd="2026-11-30" />)).window.document;
}

function valueFor(document: Document, section: string, label: string) {
  const root = document.querySelector(`section[aria-label="${section}"]`)!;
  const term = Array.from(root.querySelectorAll("td:first-child")).find(item => item.textContent === label);
  return term?.nextElementSibling?.textContent;
}

describe("compact A5 salary slip", () => {
  test("shows full employee identity and Sri Lankan formatted money", () => {
    const doc = render();
    expect(doc.querySelector('[aria-label="Employee details"]')?.textContent).toContain("Payroll display fixture");
    expect(doc.querySelector('[aria-label="Employee details"]')?.textContent).toContain("901234567V");
    expect(valueFor(doc, "Earnings", "Gross earnings")).toBe("LKR 50,000.00");
    expect(valueFor(doc, "Deductions", "Employee EPF (8%)")).toBe("LKR 4,000.00");
    expect(valueFor(doc, "Deductions", "Net salary payable")).toBe("LKR 45,000.00");
  });

  test("separates deductions and company contributions after net salary", () => {
    const doc = render();
    expect(valueFor(doc, "Deductions", "Loan repayment")).toBe("LKR 1,000.00");
    expect(valueFor(doc, "Company contributions", "Company EPF (12%)")).toBe("LKR 6,000.00");
    expect(valueFor(doc, "Company contributions", "Company ETF (3%)")).toBe("LKR 1,500.00");
    expect(doc.querySelector('section[aria-label="Company contributions"]')?.textContent).toContain("Total company contributions");
  });

  test("uses saved net and contribution amounts", () => {
    const doc = render({ ...line, employerEpfCents: 599_999, netCents: 4_499_999 });
    expect(valueFor(doc, "Company contributions", "Company EPF (12%)")).toBe("LKR 5,999.99");
    expect(valueFor(doc, "Deductions", "Net salary payable")).toBe("LKR 44,999.99");
  });

  test("has the compact title, full logo, A5 rule, and no comments", () => {
    const doc = render();
    expect(doc.querySelector("header")?.textContent).toContain("SALARY SLIP");
    expect(doc.querySelector('img[alt="NatEx logo"]')).not.toBeNull();
    expect(doc.querySelector("style")?.textContent).toContain("A5 portrait");
    expect(doc.querySelector('[role="dialog"]')?.textContent).not.toContain("Review notes");
    expect(doc.querySelector('[role="dialog"]')?.textContent).not.toContain("APIT");
    expect(doc.querySelector("footer")?.textContent).toContain("No human authorization is required");
  });
});
