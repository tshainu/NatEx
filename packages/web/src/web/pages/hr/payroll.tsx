import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { useAuth } from "@/components/auth-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { currentMonthRange, centsToLkr, downloadCsv, lkrToCents } from "./shared";
import { HrNavigation } from "./navigation";
import { Payslip } from "./payslip";
import { payrollPaySummary, type PayrollLine as Line, type PayrollSnapshot as Snapshot } from "./payroll-presentation";

const asLkr = (cents: number) => `LKR ${centsToLkr(cents)}`;
const monthBounds = (month: string) => {
  const [year, mm] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year!, mm!, 0)).getUTCDate();
  return { periodStart: `${month}-01`, periodEnd: `${month}-${String(last).padStart(2, "0")}` };
};

export default function HrPayroll() {
  const queryClient = useQueryClient();
  const session = useAuth().session!;
  const roles = session.user.roles?.length ? session.user.roles : [session.user.role];
  const canDraft = roles.includes("hr") || roles.includes("admin");
  const canApprove = roles.includes("finance") || roles.includes("admin");
  const defaultMonth = currentMonthRange().from.slice(0, 7);
  const [month, setMonth] = React.useState(defaultMonth);
  const [cutoffDate, setCutoffDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  const [paymentReference, setPaymentReference] = React.useState("");
  const [cancelReason, setCancelReason] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [selectedBranchIds, setSelectedBranchIds] = React.useState<string[]>([]);

  const runs = useQuery({ ...orpc.hr.payrollRuns.queryOptions(), refetchInterval: 30_000 });
  const branches = useQuery({ ...orpc.hr.branchOptions.queryOptions() });
  const detail = useQuery({
    ...orpc.hr.payrollRun.queryOptions({ input: { runId: selectedRunId ?? "" } }),
    enabled: Boolean(selectedRunId),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.hr.payrollRuns.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.payrollRun.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.statutoryReport.key() });
  };
  const create = useMutation({ ...orpc.hr.createPayrollRun.mutationOptions(), onSuccess: (result) => { setSelectedRunId(result.run.id); setNote(`${result.run.code} was calculated as a draft. Review every employee line and statutory exception.`); refresh(); } });
  const submit = useMutation({ ...orpc.hr.submitPayrollRun.mutationOptions(), onSuccess: () => { setNote("Payroll was submitted for Finance/Admin review."); refresh(); } });
  const approve = useMutation({ ...orpc.hr.approvePayrollRun.mutationOptions(), onSuccess: () => { setNote("Payroll was approved and is ready for payment."); refresh(); } });
  const paid = useMutation({ ...orpc.hr.recordPayrollPayment.mutationOptions(), onSuccess: () => { setNote("Payment reference was recorded; the payroll run is marked paid."); setPaymentReference(""); refresh(); } });
  const editLine = useMutation({ ...orpc.hr.editPayrollLine.mutationOptions(), onSuccess: () => { setNote("Draft payroll line updated and totals recomputed."); refresh(); } });
  const approveLines = useMutation({ ...orpc.hr.approvePayrollLines.mutationOptions(), onSuccess: () => { setNote("Selected salaries approved and locked."); refresh(); } });
  const cancel = useMutation({ ...orpc.hr.cancelDraftPayrollRun.mutationOptions(), onSuccess: () => { setNote("Draft was cancelled with an audit reason. Timesheets for that period are unlocked."); setCancelReason(""); refresh(); } });

  const selectedRun = detail.data?.run;
  const canExport = Boolean(selectedRun && ["approved", "paid"].includes(selectedRun.status));
  const statutory = useQuery({
    ...orpc.hr.statutoryReport.queryOptions({ input: { runId: selectedRunId ?? "" } }),
    enabled: Boolean(selectedRunId && canExport),
  });
  const errors = runs.error ?? branches.error ?? detail.error ?? create.error ?? submit.error ?? approve.error ?? editLine.error ?? approveLines.error ?? paid.error ?? cancel.error;

  function exportStatutory() {
    if (!statutory.data) return;
    const rows: unknown[][] = [["Employee code", "Employee name", "EPF no.", "EPF wage (LKR)", "Employee EPF 8% (LKR)", "Employee ETF deduction (new runs: 0) (LKR)", "Employer EPF 12% (LKR)", "ETF wage (LKR)", "Employer ETF contribution 3% (LKR)", "Gross pay (LKR)", "Net pay (LKR)"]];
    for (const row of statutory.data.rows) rows.push([
      row.employeeCode, row.employeeName, row.epfNumber ?? "", centsToLkr(row.epfBaseCents), centsToLkr(row.employeeEpfCents),
      centsToLkr(row.employeeEtfCents), centsToLkr(row.employerEpfCents), centsToLkr(row.etfBaseCents), centsToLkr(row.employerEtfCents),
      centsToLkr(row.grossCents), centsToLkr(row.netCents),
    ]);
    downloadCsv(`NatEx-Statutory-Payroll-${selectedRun?.code ?? "run"}.csv`, rows);
  }

  return (
    <Page title="Salary operations" description="Monthly payroll drafts are prepared by HR and approved by a different Finance/Admin user. Calculations use integer cents, retain a payslip snapshot and require review before payroll approval.">
      {note ? <SuccessNote>{note}</SuccessNote> : null}
      {errors ? <ErrorNote>{apiMessage(errors, "Payroll data could not be loaded or saved.")}</ErrorNote> : null}
      <HrNavigation />
      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <Card title="Payroll runs" description="One active run per calendar month. A cancelled draft remains in the audit history; a replacement run can then be prepared.">
          {canDraft ? <form className="mb-4 space-y-3" onSubmit={(e) => { e.preventDefault(); const range = monthBounds(month); create.mutate({ ...range, cutoffDate, branchIds: selectedBranchIds.length ? selectedBranchIds : undefined }); }}>
            <div className="flex flex-wrap items-end gap-3"><Field label="Salary-sheet month"><Input type="month" required value={month} onChange={(e) => setMonth(e.target.value || defaultMonth)} /></Field><Field label="Create date (Leave cutoff date)"><Input type="date" required value={cutoffDate} onChange={(e) => setCutoffDate(e.target.value)} /></Field><Button type="submit" pending={create.isPending}>Create salary sheet</Button></div>
            <p className="text-[11px] text-muted-foreground">Create around the 24th–25th for the selected calendar month. The salary period remains the 1st through the last day; later-approved leave is carried to the next sheet as last-month leave.</p>
            <div className="flex flex-wrap gap-2">{(branches.data ?? []).filter((branch) => branch.status === "active").map((branch) => <label key={branch.id} className="flex items-center gap-1 rounded border px-2 py-1 text-[11px]"><input type="checkbox" checked={selectedBranchIds.includes(branch.id)} onChange={(e) => setSelectedBranchIds((current) => e.target.checked ? [...current, branch.id] : current.filter((id) => id !== branch.id))} />{branch.code} · {branch.name}</label>)}</div>
          </form> : null}
          <div className="space-y-2">{(runs.data ?? []).map((run) => <button key={run.id} type="button" aria-label={`Open payroll run ${run.code}`} onClick={() => setSelectedRunId(run.id)} className={`flex w-full flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-left hover:bg-muted/40 ${selectedRunId === run.id ? "border-brand" : "border-border"}`}>
            <span><span className="font-mono text-[12px]">{run.code}</span><span className="ml-2 text-[13px]">{run.periodStart} – {run.periodEnd}</span></span>
            <span className="flex items-center gap-3"><span className="font-mono text-[12px]">{asLkr(run.netCents)}</span><Badge variant={run.status === "approved" || run.status === "paid" ? "good" : run.status === "submitted" ? "brand" : run.status === "draft" ? "warn" : "outline"}>{run.status}</Badge></span>
          </button>)}{!runs.isPending && (runs.data?.length ?? 0) === 0 ? <p className="py-6 text-center text-[13px] text-muted-foreground">No payroll runs yet.</p> : null}</div>
        </Card>
        <Card title="Payroll totals" description={selectedRun ? `${selectedRun.code} · ${selectedRun.employeeCount} employee(s)` : "Select a run to review totals."}>
          {selectedRun ? <dl className="grid grid-cols-2 gap-3 text-[13px]">
            <Total label="Gross earnings" value={selectedRun.grossCents} />
            <Total label="EPF staff deduction · 8%" value={selectedRun.employeeEpfCents} />
            <Total label="Take-home after staff EPF" value={payrollPaySummary(selectedRun).earningsAfterStaffDeductionsCents ?? payrollPaySummary(selectedRun).earningsAfterStaffEpfCents} strong />
            <Total label="Other deductions" value={selectedRun.otherDeductionsCents} />
            <Total label="Net pay / take-home pay" value={selectedRun.netCents} strong />
          </dl> : <p className="text-[13px] text-muted-foreground">Totals and employee calculations will appear here.</p>}
          {selectedRun ? <div className="mt-4 border-t pt-3">
            <h3 className="mb-3 text-[13px] font-semibold">Employer contributions</h3>
            <dl className="grid grid-cols-2 gap-3 text-[13px]">
              <Total label="EPF Company contribution · 12%" value={selectedRun.employerEpfCents} />
              <Total label="ETF employer contribution · 3%" value={selectedRun.employerEtfCents} />
            </dl>
            <p className="mt-3 text-[11px] text-muted-foreground">New salary sheets record ETF at 3% of ETF-eligible pay as an employer contribution. It is not deducted from employee salary or net pay; historical employee ETF fields remain only for compatibility.</p>
          </div> : null}
          {selectedRun && canExport ? <div className="mt-4 border-t pt-3"><Button variant="outline" disabled={!statutory.data} onClick={exportStatutory}>Download EPF / ETF CSV</Button><p className="mt-2 text-[11px] text-muted-foreground">This is an export basis for review/filing, not an IRD or statutory return form.</p></div> : null}
        </Card>
      </div>

      {selectedRun ? <Card title={`Run details · ${selectedRun.code}`} description={`State: ${selectedRun.status}. Gross and deductions are stored as an immutable calculation snapshot; correcting a draft requires cancellation and regeneration.`}>
        <div className="mb-4 flex flex-wrap gap-2">
          {canDraft && (selectedRun.status === "draft" || selectedRun.status === "returned") ? <>
            <Button disabled={submit.isPending} pending={submit.isPending} onClick={() => submit.mutate({ runId: selectedRun.id })}>Submit for Finance approval</Button>
            {selectedRun.status === "draft" ? <><Button variant="outline" disabled={cancel.isPending || cancelReason.trim().length < 5} onClick={() => cancel.mutate({ runId: selectedRun.id, reason: cancelReason })}>Cancel draft</Button>
            <Input className="max-w-sm" placeholder="Cancellation reason (required)" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} /></> : null}
          </> : null}
          {canApprove && selectedRun.status === "submitted" ? <Button pending={approve.isPending} onClick={() => approve.mutate({ runId: selectedRun.id })}>Approve payroll</Button> : null}
          {canApprove && selectedRun.status === "approved" ? <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); paid.mutate({ runId: selectedRun.id, reference: paymentReference }); }}><Field label="Bank payment reference"><Input required minLength={3} value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} /></Field><Button type="submit" pending={paid.isPending}>Record paid</Button></form> : null}
        </div>
        {detail.data ? <PayrollTable lines={detail.data.lines} status={selectedRun.status} periodStart={selectedRun.periodStart} periodEnd={selectedRun.periodEnd} canDraft={canDraft} runId={selectedRun.id} onEditLine={(input) => editLine.mutate(input)} editLinePending={editLine.isPending} onApproveLines={(employeeIds) => approveLines.mutate({ runId: selectedRun.id, employeeIds })} approveLinesPending={approveLines.isPending} /> : <p className="py-8 text-center text-[13px] text-muted-foreground">Loading payroll lines…</p>}
      </Card> : null}
    </Page>
  );
}

function Total({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return <div className={`flex justify-between gap-3 border-b pb-2 ${strong ? "col-span-2 border-brand font-semibold" : ""}`}><dt className="text-muted-foreground">{label}</dt><dd className="font-mono">{asLkr(value)}</dd></div>;
}

function PayrollTable({ lines, status, periodStart, periodEnd, canDraft, runId, onEditLine, editLinePending, onApproveLines, approveLinesPending }: {
  lines: Line[];
  status: string;
  periodStart: string;
  periodEnd: string;
  canDraft: boolean;
  runId: string;
  onEditLine: (input: { runId: string; employeeId: string; grossCents?: number; otherDeductionsCents?: number; reason: string }) => void;
  editLinePending: boolean;
  onApproveLines: (employeeIds: string[]) => void;
  approveLinesPending: boolean;
}) {
  const [printLine, setPrintLine] = React.useState<Line | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  function print(line: Line) {
    setPrintLine(line);
  }
  React.useEffect(() => {
    if (!printLine) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => window.print());
    });
    return () => { window.cancelAnimationFrame(firstFrame); if (secondFrame) window.cancelAnimationFrame(secondFrame); };
  }, [printLine]);
  React.useEffect(() => {
    const closePrint = () => setPrintLine(null);
    window.addEventListener("afterprint", closePrint);
    return () => window.removeEventListener("afterprint", closePrint);
  }, []);

  return <>
    <div className="mb-3 flex flex-wrap items-center gap-2"><p className="text-[12px] text-muted-foreground">Amounts are LKR. Employee ETF is zero for new salary sheets. ETF is paid by the employer at 3% of ETF-eligible pay and does not reduce net pay; historical runs retain their original snapshot.</p>{canDraft === false && status === "submitted" ? <Button size="sm" disabled={!selected.length || approveLinesPending} pending={approveLinesPending} onClick={() => onApproveLines(selected)}>Approve selected salaries</Button> : null}</div>
    <div className="overflow-x-auto"><table className="w-full min-w-[1700px] text-left text-[12px]"><thead><tr className="border-b text-[10px] uppercase text-muted-foreground"><th className="p-2"><input aria-label="Select all salary lines" type="checkbox" checked={selected.length === lines.length && lines.length > 0} onChange={(e) => setSelected(e.target.checked ? lines.map((line) => line.employeeId) : [])} /></th><th className="p-2">Employee</th><th className="p-2 text-right">Gross earnings</th><th className="p-2 text-right">EPF base</th><th className="p-2 text-right">EPF staff deduction · 8%</th><th className="p-2 text-right">Take-home after staff EPF</th><th className="p-2 text-right">Other deductions</th><th className="p-2 text-right">Net pay</th><th className="p-2 text-right">EPF Company contribution · 12%</th><th className="p-2 text-right">ETF employer contribution · 3%</th><th className="p-2">Review / payslip</th></tr></thead><tbody>{lines.map((line) => {
      const snapshot = JSON.parse(line.breakdownJson) as Snapshot;
      return <tr key={line.id} className="border-b border-border/60 align-top"><td className="p-2"><input aria-label={`Select salary for ${line.employeeCode}`} type="checkbox" checked={selected.includes(line.employeeId)} onChange={() => setSelected((current) => current.includes(line.employeeId) ? current.filter((id) => id !== line.employeeId) : [...current, line.employeeId])} /></td><td className="p-2"><span className="font-mono">{line.employeeCode}</span><span className="block font-medium">{line.employeeName}</span><span className="text-[10px] text-muted-foreground">{line.payBasis}</span></td><MoneyCell value={line.grossCents} /><MoneyCell value={line.epfBaseCents} /><MoneyCell value={line.employeeEpfCents} /><MoneyCell value={payrollPaySummary(line).earningsAfterStaffDeductionsCents ?? payrollPaySummary(line).earningsAfterStaffEpfCents} bold /><MoneyCell value={line.otherDeductionsCents} /><MoneyCell value={line.netCents} bold /><MoneyCell value={line.employerEpfCents} /><MoneyCell value={line.employerEtfCents} />
        <td className="p-2"><div className="space-y-1">{snapshot.warnings.map((warning, index) => <p key={index} className="max-w-[300px] text-[10px] text-status-warn">{warning}</p>)}<div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" onClick={() => print(line)}>Payslip</Button>{canDraft && (status === "draft" || status === "returned") ? <><DraftEditForm line={line} runId={runId} onSave={onEditLine} pending={editLinePending} /></> : null}</div></div></td>
      </tr>;
    })}</tbody></table></div>
    {printLine ? <Payslip line={printLine} status={status} periodStart={periodStart} periodEnd={periodEnd} /> : null}
  </>;
}

function MoneyCell({ value, bold = false }: { value: number; bold?: boolean }) {
  return <td className={`whitespace-nowrap p-2 text-right font-mono ${bold ? "font-semibold" : ""}`}>{centsToLkr(value)}</td>;
}

function DraftEditForm({ line, runId, onSave, pending }: { line: Line; runId: string; onSave: (input: { runId: string; employeeId: string; grossCents?: number; otherDeductionsCents?: number; reason: string }) => void; pending: boolean }) {
  const [gross, setGross] = React.useState(centsToLkr(line.grossCents)); const [deductions, setDeductions] = React.useState(centsToLkr(line.otherDeductionsCents)); const [reason, setReason] = React.useState("");
  return <form className="mt-1 flex flex-wrap items-center gap-1" onSubmit={(e) => { e.preventDefault(); const g = lkrToCents(gross), d = lkrToCents(deductions); if (g !== null && d !== null && reason.trim().length >= 5) onSave({ runId, employeeId: line.employeeId, grossCents: g, otherDeductionsCents: d, reason }); }}><input aria-label={`Edit gross earnings for ${line.employeeCode}`} className="h-8 w-24 rounded border px-2 font-mono" type="number" min="0" step="0.01" value={gross} onChange={(e) => setGross(e.target.value)} /><input aria-label={`Edit deductions for ${line.employeeCode}`} className="h-8 w-24 rounded border px-2 font-mono" type="number" min="0" step="0.01" value={deductions} onChange={(e) => setDeductions(e.target.value)} /><input aria-label={`Reason for payroll edit ${line.employeeCode}`} className="h-8 w-32 rounded border px-2" placeholder="Reason" minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} /><Button size="sm" variant="ghost" type="submit" disabled={reason.trim().length < 5} pending={pending}>Save edit</Button></form>;
}
