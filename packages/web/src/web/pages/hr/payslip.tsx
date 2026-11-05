import { centsToLkr } from "./shared";
import { payrollPaySummary, type PayrollLine, type PayrollSnapshot } from "./payroll-presentation";

interface PayslipProps {
  line: PayrollLine;
  status: string;
  periodStart: string;
  periodEnd: string;
}

export function Payslip({ line, status, periodStart, periodEnd }: PayslipProps) {
  const snapshot = JSON.parse(line.breakdownJson) as PayrollSnapshot;
  const summary = payrollPaySummary(line);
  const stateLabel = status === "paid" ? "Paid" : status === "approved" ? "Approved / ready for payment" : "DRAFT — not approved";

  return <dialog open className="hr-print-slip" aria-label={`Payslip ${line.employeeCode}`}>
    <style>{`
      @media screen {.hr-print-slip{display:none}}
      @media print {
        body *{visibility:hidden!important}
        .hr-print-slip,.hr-print-slip *{visibility:visible!important}
        .hr-print-slip{display:block!important;position:absolute;inset:0 auto auto 0;width:100%;max-width:none;margin:0;border:0;background:white;color:#111;padding:28px;font-family:Arial,sans-serif;font-size:12px;box-sizing:border-box}
        .hr-print-slip table{width:100%;border-collapse:collapse}
        .hr-print-slip th,.hr-print-slip td{padding:6px;border-bottom:1px solid #ddd;text-align:left}
        .hr-print-slip .right{text-align:right;font-family:monospace}
        .hr-print-slip section{break-inside:avoid}
        .hr-print-slip dt,.hr-print-slip dd{margin:0}
      }
    `}</style>
    <header>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>NatEx · Payslip</h1>
      <p>Salary statement · {stateLabel}</p>
    </header>
    <div style={{ display: "flex", justifyContent: "space-between", margin: "20px 0" }}>
      <div><strong>{line.employeeName}</strong><p>Employee code: {line.employeeCode}</p><p>Pay basis: {line.payBasis}</p></div>
      <div><strong>Pay period</strong><p>{periodStart} – {periodEnd}</p><p>Schedule: {snapshot.apitScheduleVersion}</p></div>
    </div>
    <table aria-label="Salary components">
      <thead><tr><th>Pay / deduction item</th><th className="right">Amount (LKR)</th></tr></thead>
      <tbody>{snapshot.lines.map((item, index) => <tr key={`${item.label}-${index}`}>
        <td>{item.kind === "deduction" ? `${item.label} (deduction)` : item.label}</td>
        <td className="right">{centsToLkr(item.amountCents)}</td>
      </tr>)}</tbody>
    </table>
    <section aria-label="Employee pay summary" style={{ marginTop: 20 }}>
      <h2 style={{ fontSize: 14, fontWeight: 700 }}>Employee pay summary</h2>
      <dl>
        <PayslipAmount label="Gross earnings" amountCents={line.grossCents} />
        <PayslipAmount label="EPF staff deduction · 8%" amountCents={line.employeeEpfCents} />
        <PayslipAmount label="Total earnings after staff EPF" amountCents={summary.earningsAfterStaffEpfCents} strong />
        <PayslipAmount label="APIT withheld" amountCents={line.apitCents} />
        <PayslipAmount label="Other deductions" amountCents={line.otherDeductionsCents} />
        <PayslipAmount label="Net pay / take-home pay" amountCents={summary.netCents} strong />
      </dl>
      <p style={{ margin: "4px 0 8px", fontSize: 10, color: "#555" }}>Total earnings after staff EPF is before APIT and other employee deductions.</p>
    </section>
    <section aria-label="Company-paid contributions" style={{ marginTop: 20, borderTop: "1px solid #bbb", paddingTop: 12 }}>
      <h2 style={{ fontSize: 14, fontWeight: 700 }}>Company-paid contributions</h2>
      <dl>
        <PayslipAmount label="EPF Company contribution · 12%" amountCents={line.employerEpfCents} />
        <PayslipAmount label="ETF Company contribution · 3%" amountCents={line.employerEtfCents} />
        <PayslipAmount label="Total Company contributions" amountCents={summary.companyContributionsCents} strong />
      </dl>
      <p style={{ marginTop: 8, fontSize: 11 }}>Paid separately by NatEx. Company EPF and ETF contributions are not deducted from or added to your net pay.</p>
    </section>
    {snapshot.warnings.length ? <p style={{ marginTop: 18, fontSize: 11 }}>Review notes: {snapshot.warnings.join(" · ")}</p> : null}
    <p style={{ marginTop: 24, fontSize: 10, color: "#555" }}>This payslip is a NatEx payroll record. Statutory submissions and withholding remain subject to current law and accountant review.</p>
  </dialog>;
}

function PayslipAmount({ label, amountCents, strong = false }: { label: string; amountCents: number; strong?: boolean }) {
  return <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "5px 0", fontWeight: strong ? 700 : 400 }}>
    <dt>{label}</dt><dd className="right">LKR {centsToLkr(amountCents)}</dd>
  </div>;
}
