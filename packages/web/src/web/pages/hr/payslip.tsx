import { centsToLkr } from "./shared";
import { payrollPaySummary, type PayrollLine, type PayrollSnapshot } from "./payroll-presentation";

interface PayslipProps {
  line: PayrollLine;
  status: string;
  periodStart: string;
  periodEnd: string;
}

const money = (cents: number) => {
  const value = Number(centsToLkr(cents));
  return `LKR ${new Intl.NumberFormat("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
};

export function Payslip({ line, periodStart, periodEnd }: PayslipProps) {
  const snapshot = JSON.parse(line.breakdownJson) as PayrollSnapshot;
  const summary = payrollPaySummary(line);
  const earnings = snapshot.lines.filter((item) => item.kind === "earning");
  const packageDeductions = snapshot.lines.filter((item) => item.kind === "deduction");
  const totalDeductions = line.grossCents - line.netCents;

  return <dialog open className="hr-print-slip" aria-label={`Salary slip ${line.employeeCode}`}>
    <style>{`
      @media screen {.hr-print-slip{display:none}}
      @media print {
        @page { size: A5 portrait; margin: 8mm; }
        html,body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
        body *{visibility:hidden!important}
        .hr-print-slip,.hr-print-slip *{visibility:visible!important}
        .hr-print-slip{display:block!important;position:absolute;inset:0 auto auto 0;width:148mm;min-height:210mm;margin:0;border:0;background:#fff;color:#17211b;padding:0;font-family:Arial,sans-serif;font-size:9px;line-height:1.25;box-sizing:border-box}
        .hr-print-slip table{width:100%;border-collapse:collapse}
        .hr-print-slip th,.hr-print-slip td{padding:4px 5px;border-bottom:1px solid #dce5df;text-align:left}
        .hr-print-slip th{background:#edf6ef;color:#155b31;font-size:8px;text-transform:uppercase;letter-spacing:.04em}
        .hr-print-slip .right{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
        .hr-print-slip section{break-inside:avoid;margin-top:9px}
        .hr-print-slip dt,.hr-print-slip dd{margin:0}
        .hr-print-slip .section-title{margin:0 0 4px;padding:4px 6px;background:#0b6b35;color:#fff;border-radius:3px;font-size:9px;text-transform:uppercase;letter-spacing:.06em}
        .hr-print-slip .total-row td{border-top:1px solid #8aa994;border-bottom:2px solid #8aa994;font-weight:700}
        .hr-print-slip .net-row td{background:#e8f5eb;color:#084e28;font-size:10px;font-weight:700}
      }
    `}</style>
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "2px solid #0b6b35", paddingBottom: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <img src="/natex-logo.png" alt="NatEx logo" style={{ width: 34, height: 34, objectFit: "contain" }} />
        <div><div style={{ color: "#0b6b35", fontSize: 20, fontWeight: 800, letterSpacing: "-.04em" }}>NatEx</div><div style={{ color: "#52635a", fontSize: 8, letterSpacing: ".08em", textTransform: "uppercase" }}>National Express</div></div>
      </div>
      <div style={{ textAlign: "right" }}><div style={{ color: "#0b6b35", fontSize: 15, fontWeight: 800 }}>SALARY SLIP</div><div style={{ color: "#52635a", fontSize: 8 }}>Monthly payroll statement</div></div>
    </header>

    <section aria-label="Employee details" style={{ marginTop: 9 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1.35fr 1fr", gap: 5, border: "1px solid #dce5df", borderRadius: 4, padding: 6 }}>
        <div><span style={{ color: "#52635a", fontSize: 8 }}>Employee name</span><strong style={{ display: "block", fontSize: 11 }}>{line.employeeName}</strong></div>
        <div><span style={{ color: "#52635a", fontSize: 8 }}>NIC number</span><strong style={{ display: "block", fontSize: 10 }}>{line.nationalId || "—"}</strong></div>
        <div><span style={{ color: "#52635a", fontSize: 8 }}>Employee number</span><strong style={{ display: "block", fontSize: 10 }}>{line.employeeCode}</strong></div>
        <div><span style={{ color: "#52635a", fontSize: 8 }}>Pay period</span><strong style={{ display: "block", fontSize: 10 }}>{periodStart} – {periodEnd}</strong></div>
      </div>
    </section>

    <section aria-label="Earnings">
      <h2 className="section-title">Earnings</h2>
      <table><thead><tr><th>Salary component</th><th className="right">Amount (LKR)</th></tr></thead><tbody>{earnings.map((item, index) => <tr key={`${item.label}-${index}`}><td>{item.label}</td><td className="right">{money(item.amountCents)}</td></tr>)}<tr className="total-row"><td>Gross earnings</td><td className="right">{money(line.grossCents)}</td></tr></tbody></table>
    </section>

    <section aria-label="Deductions">
      <h2 className="section-title">Deductions</h2>
      <table><thead><tr><th>Deduction</th><th className="right">Amount (LKR)</th></tr></thead><tbody><tr><td>Employee EPF (8%)</td><td className="right">{money(line.employeeEpfCents)}</td></tr>{packageDeductions.map((item, index) => <tr key={`${item.label}-${index}`}><td>{item.label}</td><td className="right">{money(item.amountCents)}</td></tr>)}{line.otherDeductionsCents > packageDeductions.reduce((sum, item) => sum + item.amountCents, 0) ? <tr><td>Other deductions</td><td className="right">{money(line.otherDeductionsCents - packageDeductions.reduce((sum, item) => sum + item.amountCents, 0))}</td></tr> : null}<tr className="total-row"><td>Total deductions</td><td className="right">{money(totalDeductions)}</td></tr><tr className="net-row"><td>Net salary payable</td><td className="right">{money(summary.netCents)}</td></tr></tbody></table>
    </section>

    <section aria-label="Company contributions">
      <h2 className="section-title">Company contributions</h2>
      <table><thead><tr><th>Contribution</th><th className="right">Amount (LKR)</th></tr></thead><tbody><tr><td>Company EPF (12%)</td><td className="right">{money(line.employerEpfCents)}</td></tr><tr><td>Company ETF (3%)</td><td className="right">{money(line.employerEtfCents)}</td></tr><tr className="total-row"><td>Total company contributions</td><td className="right">{money(summary.companyContributionsCents)}</td></tr></tbody></table>
    </section>

    <footer style={{ marginTop: 10, borderTop: "1px solid #dce5df", paddingTop: 6, textAlign: "center", color: "#52635a", fontSize: 8 }}>
      System-generated salary slip. No human authorization is required.
    </footer>
  </dialog>;
}
