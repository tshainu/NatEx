import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { useAuth } from "@/components/auth-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { centsToLkr } from "../hr/shared";
import { Payslip, printPayslipInWindow } from "../hr/payslip";
import { payrollPaySummary, type PayrollLine as Line, type PayrollSnapshot as Snapshot } from "../hr/payroll-presentation";

const asLkr = (cents: number) => `LKR ${centsToLkr(cents)}`;

export default function FinancePayrollApprovals() {
  const session = useAuth().session!;
  const roles = session.user.roles?.length ? session.user.roles : [session.user.role];
  const canApprove = roles.includes("finance") || roles.includes("admin");
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);

  const runs = useQuery({ ...orpc.hr.payrollRuns.queryOptions(), refetchInterval: 30_000 });
  const submittedRuns = (runs.data ?? []).filter((run) => run.status === "submitted");
  const selectedId = selectedRunId ?? submittedRuns[0]?.id ?? null;
  const detail = useQuery({
    ...orpc.hr.payrollRun.queryOptions({ input: { runId: selectedId ?? "" } }),
    enabled: Boolean(selectedId),
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.hr.payrollRuns.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.payrollRun.key() });
  };
  const approve = useMutation({
    ...orpc.hr.approvePayrollRun.mutationOptions(),
    onSuccess: () => { setNote("Payroll approved and locked. Finance can now record the payment reference."); setReason(""); invalidate(); },
  });
  const returnToHr = useMutation({
    ...orpc.hr.returnPayrollRun.mutationOptions(),
    onSuccess: () => { setNote("Payroll returned to HR for correction. HR can edit and resubmit it."); setReason(""); invalidate(); },
  });
  const reject = useMutation({
    ...orpc.hr.rejectPayrollRun.mutationOptions(),
    onSuccess: () => { setNote("Payroll rejected and closed. HR can prepare a replacement salary sheet."); setReason(""); invalidate(); },
  });
  const selectedRun = detail.data?.run;
  const error = runs.error ?? detail.error ?? approve.error ?? returnToHr.error ?? reject.error;
  const busy = approve.isPending || returnToHr.isPending || reject.isPending;

  return (
    <Page title="Payroll approvals" description="Finance reviews salary sheets submitted by HR. Approve to lock payroll, return for correction, or reject with a recorded reason.">
      {note ? <SuccessNote>{note}</SuccessNote> : null}
      {error ? <ErrorNote>{apiMessage(error, "Payroll approval data could not be loaded or saved.")}</ErrorNote> : null}
      <div className="grid gap-4 xl:grid-cols-[1fr_1.6fr]">
        <Card title="Pending Finance approvals" description={`${submittedRuns.length} salary sheet${submittedRuns.length === 1 ? "" : "s"} awaiting review`}>
          <div className="space-y-2">
            {submittedRuns.map((run) => <button key={run.id} type="button" aria-label={`Review payroll ${run.code}`} onClick={() => setSelectedRunId(run.id)} className={`flex w-full flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-left hover:bg-muted/40 ${selectedId === run.id ? "border-brand" : "border-border"}`}>
              <span><span className="font-mono text-[12px]">{run.code}</span><span className="ml-2 text-[13px]">{run.periodStart} – {run.periodEnd}</span><span className="block text-[11px] text-muted-foreground">{run.employeeCount} employee(s)</span></span>
              <span className="text-right"><Badge variant="brand">submitted</Badge><span className="mt-1 block font-mono text-[12px]">{asLkr(run.netCents)}</span></span>
            </button>)}
            {!runs.isPending && submittedRuns.length === 0 ? <p className="py-8 text-center text-[13px] text-muted-foreground">No payroll is waiting for Finance approval.</p> : null}
          </div>
        </Card>
        <Card title={selectedRun ? `Review · ${selectedRun.code}` : "Select a salary sheet"} description={selectedRun ? `${selectedRun.periodStart} – ${selectedRun.periodEnd} · submitted by HR for Finance review` : "Submitted salary sheets will appear here."}>
          {selectedRun ? <>
            <dl className="mb-4 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
              <Total label="Employees" value={`${selectedRun.employeeCount}`} raw />
              <Total label="Gross earnings" value={asLkr(selectedRun.grossCents)} raw />
              <Total label="Other deductions" value={asLkr(selectedRun.otherDeductionsCents)} raw />
              <Total label="Net pay" value={asLkr(selectedRun.netCents)} raw strong />
            </dl>
            {detail.data ? <FinancePayrollTable lines={detail.data.lines} status={selectedRun.status} periodStart={selectedRun.periodStart} periodEnd={selectedRun.periodEnd} /> : <p className="py-8 text-center text-[13px] text-muted-foreground">Loading payroll lines…</p>}
            <div className="mt-4 border-t pt-4">
              <Field label="Decision note" hint="Required when returning or rejecting payroll."><Input value={reason} minLength={5} placeholder="Explain the correction or rejection reason" onChange={(event) => setReason(event.target.value)} /></Field>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button disabled={!canApprove || busy} pending={approve.isPending} onClick={() => approve.mutate({ runId: selectedRun.id })}>Approve and lock payroll</Button>
                <Button variant="outline" disabled={!canApprove || busy || reason.trim().length < 5} pending={returnToHr.isPending} onClick={() => returnToHr.mutate({ runId: selectedRun.id, reason })}>Return to HR</Button>
                <Button variant="destructive" disabled={!canApprove || busy || reason.trim().length < 5} pending={reject.isPending} onClick={() => reject.mutate({ runId: selectedRun.id, reason })}>Reject payroll</Button>
              </div>
            </div>
          </> : <p className="py-8 text-center text-[13px] text-muted-foreground">Choose a submitted salary sheet to review.</p>}
        </Card>
      </div>
    </Page>
  );
}

function Total({ label, value, raw = false, strong = false }: { label: string; value: string; raw?: boolean; strong?: boolean }) {
  return <div className={`border-b pb-2 ${strong ? "border-brand font-semibold" : ""}`}><dt className="text-muted-foreground">{label}</dt><dd className={raw ? "font-mono" : undefined}>{value}</dd></div>;
}

function FinancePayrollTable({ lines, status, periodStart, periodEnd }: { lines: Line[]; status: string; periodStart: string; periodEnd: string }) {
  const [printLine, setPrintLine] = React.useState<Line | null>(null);
  const printWindowRef = React.useRef<Window | null>(null);
  React.useEffect(() => {
    const closePrint = () => setPrintLine(null);
    window.addEventListener("afterprint", closePrint);
    return () => window.removeEventListener("afterprint", closePrint);
  }, []);
  React.useEffect(() => {
    const target = printWindowRef.current;
    const source = document.querySelector<HTMLElement>(".hr-print-slip");
    if (!printLine || !target || !source) return;
    printPayslipInWindow(target, source, () => { printWindowRef.current = null; setPrintLine(null); });
  }, [printLine]);
  return <>
    <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-left text-[12px]"><thead><tr className="border-b text-[10px] uppercase text-muted-foreground"><th className="p-2">Employee</th><th className="p-2 text-right">Gross</th><th className="p-2 text-right">Staff EPF</th><th className="p-2 text-right">Other deductions</th><th className="p-2 text-right">Net pay</th><th className="p-2">Review</th></tr></thead><tbody>{lines.map((line) => { const snapshot = JSON.parse(line.breakdownJson) as Snapshot; return <tr key={line.id} className="border-b border-border/60 align-top"><td className="p-2"><span className="font-mono">{line.employeeCode}</span><span className="block font-medium">{line.employeeName}</span><span className="text-[10px] text-muted-foreground">{line.payBasis}</span></td><MoneyCell value={line.grossCents} /><MoneyCell value={line.employeeEpfCents} /><MoneyCell value={line.otherDeductionsCents} /><MoneyCell value={line.netCents} bold /><td className="p-2"><div className="space-y-1">{snapshot.warnings.map((warning, index) => <p key={index} className="max-w-[280px] text-[10px] text-status-warn">{warning}</p>)}<Button size="sm" variant="outline" onClick={() => { printWindowRef.current = window.open("", "_blank", "width=900,height=900"); setPrintLine(line); }}>Open payslip</Button><span className="ml-2 text-[10px] text-muted-foreground">Take-home {centsToLkr(payrollPaySummary(line).earningsAfterStaffDeductionsCents ?? payrollPaySummary(line).earningsAfterStaffEpfCents)}</span></div></td></tr>; })}</tbody></table></div>
    {printLine ? <Payslip line={printLine} status={status} periodStart={periodStart} periodEnd={periodEnd} /> : null}
  </>;
}

function MoneyCell({ value, bold = false }: { value: number; bold?: boolean }) {
  return <td className={`whitespace-nowrap p-2 text-right font-mono ${bold ? "font-semibold" : ""}`}>{centsToLkr(value)}</td>;
}
