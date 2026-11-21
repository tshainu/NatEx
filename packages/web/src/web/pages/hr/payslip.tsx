import { centsToLkr } from "./shared";
import { payrollPaySummary, type PayrollLine, type PayrollSnapshot } from "./payroll-presentation";

interface PayslipProps { line: PayrollLine; status: string; periodStart: string; periodEnd: string; }
const money = (cents: number) => `LKR ${new Intl.NumberFormat("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(centsToLkr(cents)))}`;

export function printPayslipInWindow(target: Window, source: HTMLElement, onAfterPrint?: () => void) {
  const sourceStyle = source.querySelector("style")?.textContent ?? "";
  const bodyMarkup = source.innerHTML;
  target.document.open();
  target.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>NatEx Salary Slip</title><style>${sourceStyle}
    @media print { @page { size: A5 portrait; margin: 8mm; } }
    html, body { margin: 0; padding: 0; background: #fff; }
    .hr-print-slip { display: block !important; position: relative !important; inset: auto !important; left: auto !important; top: auto !important; width: 100% !important; max-width: 132mm !important; min-height: 0 !important; margin: 0 auto !important; padding: 0 !important; overflow: visible !important; visibility: visible !important; }
    .hr-print-slip, .hr-print-slip * { visibility: visible !important; }
  </style></head><body>${bodyMarkup}</body></html>`);
  target.document.close();
  target.focus();
  target.addEventListener("afterprint", () => { onAfterPrint?.(); target.close(); }, { once: true });
  window.setTimeout(() => target.print(), 80);
}

export function Payslip({ line, periodStart, periodEnd }: PayslipProps) {
  const snapshot = JSON.parse(line.breakdownJson) as PayrollSnapshot;
  const summary = payrollPaySummary(line);
  const earnings = snapshot.lines.filter((item) => item.kind === "earning");
  const packageDeductions = snapshot.lines.filter((item) => item.kind === "deduction");
  const packageDeductionCents = packageDeductions.reduce((sum, item) => sum + item.amountCents, 0);
  const totalDeductions = line.grossCents - line.netCents;

  return <div className="hr-print-slip" role="dialog" aria-label={`Salary slip ${line.employeeCode}`}>
    <style>{`
      @media screen { .hr-print-slip { position: absolute; top: 0; left: -10000px; display: block; width: 132mm; } }
      @media print {
        @page { size: A5 portrait; margin: 8mm; }
        html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
        body * { visibility: hidden !important; }
        .hr-print-slip, .hr-print-slip * { visibility: visible !important; }
        .hr-print-slip { display: block !important; position: relative !important; inset: auto !important; width: 100% !important; max-width: 132mm !important; min-height: 0 !important; margin: 0 auto !important; border: 0 !important; padding: 0 !important; overflow: visible !important; box-sizing: border-box !important; background: #fff !important; color: #101513 !important; font-family: Arial, Helvetica, sans-serif !important; font-size: 8.5px !important; line-height: 1.25 !important; }
        .hr-print-slip *, .hr-print-slip *::before, .hr-print-slip *::after { box-sizing: border-box; }
        .hr-print-slip table { width: 100%; table-layout: fixed; border-collapse: collapse; }
        .hr-print-slip th, .hr-print-slip td { padding: 3.5px 5px; border-bottom: 1px solid #dfe5e1; text-align: left; overflow-wrap: anywhere; }
        .hr-print-slip th { color: #101513; background: #f3f5f3; font-size: 7.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
        .hr-print-slip th:first-child, .hr-print-slip td:first-child { width: 59%; }
        .hr-print-slip th:last-child, .hr-print-slip td:last-child { width: 41%; }
        .hr-print-slip .right { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: visible; }
        .hr-print-slip section { break-inside: avoid; margin-top: 8px; }
        .hr-print-slip .section-title { margin: 0 0 4px; padding: 0 0 3px; border-bottom: 2px solid #111; color: #111 !important; background: transparent !important; font-size: 9px; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; }
        .hr-print-slip .total-row td { border-top: 1px solid #9ca9a0; border-bottom: 2px solid #27332c; font-weight: 800; }
        .hr-print-slip .net-row td { border-bottom: 0; background: #e9f5ec; color: #0b5e2b; font-size: 9.5px; font-weight: 900; }
      }
    `}</style>
    <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10, padding: "0 0 8px", borderBottom: "2px solid #126b35" }}>
      <img src="/natex-payslip-logo.jpg" alt="NatEx logo" style={{ display: "block", width: 142, height: 46, objectFit: "contain", objectPosition: "left center", maxWidth: "58%" }} />
      <div style={{ minWidth: 0, textAlign: "right" }}><div style={{ color: "#101513", fontSize: 15, fontWeight: 900, letterSpacing: ".02em", lineHeight: 1.05 }}>SALARY SLIP</div><div style={{ marginTop: 3, color: "#56635b", fontSize: 8, letterSpacing: ".05em" }}>MONTHLY PAYROLL STATEMENT</div></div>
    </header>
    <section aria-label="Employee details" style={{ marginTop: 8 }}><div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)", gap: "6px 10px", border: "1px solid #d9e2dc", borderRadius: 7, padding: 8, background: "#fbfcfb" }}>
      <div style={{ minWidth: 0 }}><span style={{ color: "#66736b", fontSize: 7.5 }}>Employee name</span><strong style={{ display: "block", marginTop: 1, fontSize: 11, overflowWrap: "anywhere" }}>{line.employeeName}</strong></div>
      <div style={{ minWidth: 0 }}><span style={{ color: "#66736b", fontSize: 7.5 }}>NIC number</span><strong style={{ display: "block", marginTop: 1, fontSize: 9.5, overflowWrap: "anywhere" }}>{line.nationalId || "—"}</strong></div>
      <div style={{ minWidth: 0 }}><span style={{ color: "#66736b", fontSize: 7.5 }}>Employee number</span><strong style={{ display: "block", marginTop: 1, fontSize: 9.5 }}>{line.employeeCode}</strong></div>
      <div style={{ minWidth: 0 }}><span style={{ color: "#66736b", fontSize: 7.5 }}>Pay period</span><strong style={{ display: "block", marginTop: 1, fontSize: 9.5, overflowWrap: "anywhere" }}>{periodStart} – {periodEnd}</strong></div>
    </div></section>
    <section aria-label="Earnings"><h2 className="section-title">Earnings</h2><table><thead><tr><th>Salary component</th><th className="right">Amount (LKR)</th></tr></thead><tbody>{earnings.map((item, index) => <tr key={`${item.label}-${index}`}><td>{item.label}</td><td className="right">{money(item.amountCents)}</td></tr>)}<tr className="total-row"><td>Gross earnings</td><td className="right">{money(line.grossCents)}</td></tr></tbody></table></section>
    <section aria-label="Deductions"><h2 className="section-title">Deductions</h2><table><thead><tr><th>Deduction</th><th className="right">Amount (LKR)</th></tr></thead><tbody><tr><td>Employee EPF (8%)</td><td className="right">{money(line.employeeEpfCents)}</td></tr>{packageDeductions.map((item, index) => <tr key={`${item.label}-${index}`}><td>{item.label}</td><td className="right">{money(item.amountCents)}</td></tr>)}{line.otherDeductionsCents > packageDeductionCents ? <tr><td>Other deductions</td><td className="right">{money(line.otherDeductionsCents - packageDeductionCents)}</td></tr> : null}<tr className="total-row"><td>Total deductions</td><td className="right">{money(totalDeductions)}</td></tr><tr className="net-row"><td>Net salary payable</td><td className="right">{money(summary.netCents)}</td></tr></tbody></table></section>
    <section aria-label="Company contributions"><h2 className="section-title">Company contributions</h2><table><thead><tr><th>Contribution</th><th className="right">Amount (LKR)</th></tr></thead><tbody><tr><td>Company EPF (12%)</td><td className="right">{money(line.employerEpfCents)}</td></tr><tr><td>Company ETF (3%)</td><td className="right">{money(line.employerEtfCents)}</td></tr><tr className="total-row"><td>Total company contributions</td><td className="right">{money(summary.companyContributionsCents)}</td></tr></tbody></table></section>
    <footer style={{ marginTop: 9, paddingTop: 6, borderTop: "1px solid #d9e2dc", textAlign: "center", color: "#56635b", fontSize: 7.5 }}>System-generated salary slip. No human authorization is required.</footer>
  </div>;
}
