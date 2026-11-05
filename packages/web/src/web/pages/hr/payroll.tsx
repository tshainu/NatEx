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

type ApitBandForm = { maxMonthlyLkr: string; ratePercent: string; offsetLkr: string };
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
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  const [accountantName, setAccountantName] = React.useState("");
  const [taxReference, setTaxReference] = React.useState("");
  const [paymentReference, setPaymentReference] = React.useState("");
  const [cancelReason, setCancelReason] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [bandForm, setBandForm] = React.useState<ApitBandForm[]>([]);

  const runs = useQuery({ ...orpc.hr.payrollRuns.queryOptions(), refetchInterval: 30_000 });
  const schedule = useQuery({ ...orpc.hr.apitSchedule.queryOptions() });
  React.useEffect(() => {
    if (!schedule.data) return;
    try {
      const bands = JSON.parse(schedule.data.scheduleJson) as { maxMonthlyCents: number | null; rateBps: number; offsetCents: number }[];
      setBandForm(bands.map((band) => ({
        maxMonthlyLkr: band.maxMonthlyCents === null ? "" : centsToLkr(band.maxMonthlyCents),
        ratePercent: (band.rateBps / 100).toFixed(2),
        offsetLkr: centsToLkr(band.offsetCents),
      })));
    } catch {
      setBandForm([]);
    }
  }, [schedule.data]);
  const detail = useQuery({
    ...orpc.hr.payrollRun.queryOptions({ input: { runId: selectedRunId ?? "" } }),
    enabled: Boolean(selectedRunId),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.hr.payrollRuns.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.payrollRun.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.apitSchedule.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.statutoryReport.key() });
  };
  const create = useMutation({ ...orpc.hr.createPayrollRun.mutationOptions(), onSuccess: (result) => { setSelectedRunId(result.run.id); setNote(`${result.run.code} was calculated as a draft. Review every employee line and statutory exception.`); refresh(); } });
  const submit = useMutation({ ...orpc.hr.submitPayrollRun.mutationOptions(), onSuccess: () => { setNote("Payroll was submitted for Finance/Admin review."); refresh(); } });
  const approve = useMutation({ ...orpc.hr.approvePayrollRun.mutationOptions(), onSuccess: () => { setNote("Payroll was approved and is ready for payment."); refresh(); } });
  const validate = useMutation({ ...orpc.hr.validateApitSchedule.mutationOptions(), onSuccess: () => { setNote("Accountant validation was recorded for the current APIT schedule."); setAccountantName(""); setTaxReference(""); refresh(); } });
  const saveSchedule = useMutation({ ...orpc.hr.saveApitSchedule.mutationOptions(), onSuccess: (row) => { setNote(`APIT rules saved as ${row.version}. The new version is unverified until an accountant checks it.`); refresh(); } });
  const manualApit = useMutation({ ...orpc.hr.manualApit.mutationOptions(), onSuccess: () => { setNote("Manual APIT was saved to the draft payslip with its review reference."); refresh(); } });
  const paid = useMutation({ ...orpc.hr.recordPayrollPayment.mutationOptions(), onSuccess: () => { setNote("Payment reference was recorded; the payroll run is marked paid."); setPaymentReference(""); refresh(); } });
  const cancel = useMutation({ ...orpc.hr.cancelDraftPayrollRun.mutationOptions(), onSuccess: () => { setNote("Draft was cancelled with an audit reason. Timesheets for that period are unlocked."); setCancelReason(""); refresh(); } });

  const selectedRun = detail.data?.run;
  const canExport = Boolean(selectedRun && ["approved", "paid"].includes(selectedRun.status));
  const statutory = useQuery({
    ...orpc.hr.statutoryReport.queryOptions({ input: { runId: selectedRunId ?? "" } }),
    enabled: Boolean(selectedRunId && canExport),
  });
  const errors = runs.error ?? schedule.error ?? detail.error ?? create.error ?? submit.error ?? approve.error ?? validate.error ?? saveSchedule.error ?? manualApit.error ?? paid.error ?? cancel.error;

  function saveBands(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    const bands = bandForm.map((band) => {
      const maxInput = band.maxMonthlyLkr.trim();
      const maxMonthlyCents = maxInput ? lkrToCents(maxInput) : null;
      const offsetCents = lkrToCents(band.offsetLkr);
      if ((maxInput && maxMonthlyCents === null) || offsetCents === null || !/^\d+(?:\.\d{1,2})?$/.test(band.ratePercent.trim())) return null;
      const rateBps = Math.round(Number(band.ratePercent) * 100);
      if (!Number.isSafeInteger(rateBps)) return null;
      return { maxMonthlyCents, rateBps, offsetCents };
    });
    if (bands.some((band) => band === null)) {
      setFormError("Enter valid LKR thresholds/offsets and a marginal tax rate with up to two decimal places.");
      return;
    }
    setNote(null);
    saveSchedule.mutate({ bands: bands as { maxMonthlyCents: number | null; rateBps: number; offsetCents: number }[] });
  }

  function exportStatutory() {
    if (!statutory.data) return;
    const rows: unknown[][] = [["Employee code", "Employee name", "EPF no.", "EPF wage (LKR)", "Employee EPF 8% (LKR)", "Employer EPF 12% (LKR)", "ETF wage (LKR)", "Employer ETF 3% (LKR)", "APIT base (LKR)", "APIT (LKR)", "Gross pay (LKR)", "Net pay (LKR)"]];
    for (const row of statutory.data.rows) rows.push([
      row.employeeCode, row.employeeName, row.epfNumber ?? "", centsToLkr(row.epfBaseCents), centsToLkr(row.employeeEpfCents),
      centsToLkr(row.employerEpfCents), centsToLkr(row.etfBaseCents), centsToLkr(row.employerEtfCents),
      centsToLkr(row.apitBaseCents), centsToLkr(row.apitCents), centsToLkr(row.grossCents), centsToLkr(row.netCents),
    ]);
    downloadCsv(`NatEx-Statutory-Payroll-${selectedRun?.code ?? "run"}.csv`, rows);
  }

  return (
    <Page title="Salary operations" description="Monthly payroll drafts are prepared by HR and approved by a different Finance/Admin user. Calculations use integer cents, retain a payslip snapshot, and require accountant validation before APIT payroll approval.">
      {note ? <SuccessNote>{note}</SuccessNote> : null}
      {formError ? <ErrorNote>{formError}</ErrorNote> : null}
      {errors ? <ErrorNote>{apiMessage(errors, "Payroll data could not be loaded or saved.")}</ErrorNote> : null}
      <HrNavigation />
      <Card title={`APIT schedule · ${schedule.data?.taxYear ?? "2026/27"}`} description="Automatic APIT uses the configured monthly primary-employment schedule only. Secondary employment and non-standard pay periods require reviewed manual amounts. This release is configured for 2026/27; payroll outside those dates is blocked until a later tax-year schedule is installed and validated.">
        {schedule.data ? <div className="flex flex-wrap items-center gap-3">
          <Badge variant={schedule.data.status === "validated" ? "good" : "warn"}>{schedule.data.status}</Badge>
          <span className="text-[13px]">Effective {schedule.data.effectiveFrom} to {schedule.data.effectiveTo} · {schedule.data.version}</span>
          {schedule.data.accountantName ? <span className="text-[12px] text-muted-foreground">Reviewed by {schedule.data.accountantName} · Ref {schedule.data.validationReference}</span> : null}
        </div> : <p className="text-[13px] text-muted-foreground">Loading schedule…</p>}
        {canApprove && schedule.data ? <div className="mt-5 border-t pt-4">
          <div className="mb-3"><h3 className="text-[13px] font-semibold">Tax bands (monthly LKR)</h3><p className="mt-1 text-[12px] text-muted-foreground">Configure accountant-confirmed marginal bands and offsets. The default is provisional. Saving creates a new version, retires the previous version, and requires fresh validation; drafts using the retired schedule must be cancelled and recalculated.</p></div>
          <form onSubmit={saveBands}>
            <div className="space-y-2">
              {bandForm.map((band, index) => <div key={index} className="grid items-end gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
                <Field label={`Band ${index + 1} ceiling (LKR; blank = no upper limit)`}><Input type="number" min="0" step="0.01" value={band.maxMonthlyLkr} onChange={(e) => setBandForm((old) => old.map((row, i) => i === index ? { ...row, maxMonthlyLkr: e.target.value } : row))} /></Field>
                <Field label="Marginal rate (%)"><Input type="number" min="0" max="100" step="0.01" required value={band.ratePercent} onChange={(e) => setBandForm((old) => old.map((row, i) => i === index ? { ...row, ratePercent: e.target.value } : row))} /></Field>
                <Field label="Monthly offset (LKR)"><Input type="number" min="0" step="0.01" required value={band.offsetLkr} onChange={(e) => setBandForm((old) => old.map((row, i) => i === index ? { ...row, offsetLkr: e.target.value } : row))} /></Field>
                <Button type="button" variant="ghost" aria-label={`Remove APIT band ${index + 1}`} disabled={bandForm.length <= 1} onClick={() => setBandForm((old) => old.filter((_, i) => i !== index))}>Remove</Button>
              </div>)}
            </div>
            <div className="mt-3 flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={bandForm.length >= 20} onClick={() => setBandForm((old) => [...old, { maxMonthlyLkr: "", ratePercent: "", offsetLkr: "0.00" }])}>Add band</Button><Button type="submit" variant="outline" pending={saveSchedule.isPending}>Save new schedule version</Button></div>
          </form>
        </div> : null}
        {schedule.data?.status !== "validated" ? <div className="mt-4 rounded-md border border-status-warn/40 bg-status-warn/5 p-4">
          <p className="text-[13px] font-semibold">Accountant validation required</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">The available official 2026/27 tax publications did not provide a complete current Table 01 at the source-check date. Do not enable APIT approval until a qualified accountant has checked the actual schedule. Recording validation is an internal control; it does not replace professional advice or IRD confirmation.</p>
          {canApprove ? <form className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); validate.mutate({ accountantName, reference: taxReference }); }}>
            <Field label="Reviewing accountant"><Input required minLength={3} value={accountantName} onChange={(e) => setAccountantName(e.target.value)} /></Field>
            <Field label="Workpaper / source reference"><Input required minLength={5} value={taxReference} onChange={(e) => setTaxReference(e.target.value)} /></Field>
            <div className="self-end"><Button type="submit" variant="outline" pending={validate.isPending}>Record validation</Button></div>
          </form> : null}
        </div> : null}
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <Card title="Payroll runs" description="One active run per calendar month. A cancelled draft remains in the audit history; a replacement run can then be prepared.">
          {canDraft ? <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); const range = monthBounds(month); create.mutate(range); }}>
            <Field label="Payroll month"><Input type="month" required value={month} onChange={(e) => setMonth(e.target.value || defaultMonth)} /></Field>
            <Button type="submit" pending={create.isPending}>Calculate draft</Button>
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
            <Total label="Total earnings after staff EPF" value={payrollPaySummary(selectedRun).earningsAfterStaffEpfCents} strong />
            <Total label="APIT withheld" value={selectedRun.apitCents} />
            <Total label="Other deductions" value={selectedRun.otherDeductionsCents} />
            <Total label="Net pay / take-home pay" value={selectedRun.netCents} strong />
          </dl> : <p className="text-[13px] text-muted-foreground">Totals and employee calculations will appear here.</p>}
          {selectedRun ? <div className="mt-4 border-t pt-3">
            <h3 className="mb-3 text-[13px] font-semibold">Company-paid contributions</h3>
            <dl className="grid grid-cols-2 gap-3 text-[13px]">
              <Total label="EPF Company contribution · 12%" value={selectedRun.employerEpfCents} />
              <Total label="ETF Company contribution · 3%" value={selectedRun.employerEtfCents} />
            </dl>
            <p className="mt-3 text-[11px] text-muted-foreground">Company contributions are paid separately by NatEx and do not reduce or increase staff take-home pay. Total earnings after staff EPF is before APIT and other deductions.</p>
          </div> : null}
          {selectedRun && canExport ? <div className="mt-4 border-t pt-3"><Button variant="outline" disabled={!statutory.data} onClick={exportStatutory}>Download EPF / ETF / APIT CSV</Button><p className="mt-2 text-[11px] text-muted-foreground">This is an export basis for review/filing, not an IRD or statutory return form.</p></div> : null}
        </Card>
      </div>

      {selectedRun ? <Card title={`Run details · ${selectedRun.code}`} description={`State: ${selectedRun.status}. Gross and deductions are stored as an immutable calculation snapshot; correcting a draft requires cancellation and regeneration.`}>
        <div className="mb-4 flex flex-wrap gap-2">
          {canDraft && selectedRun.status === "draft" ? <>
            <Button disabled={submit.isPending} pending={submit.isPending} onClick={() => submit.mutate({ runId: selectedRun.id })}>Submit for Finance approval</Button>
            <Button variant="outline" disabled={cancel.isPending || cancelReason.trim().length < 5} onClick={() => cancel.mutate({ runId: selectedRun.id, reason: cancelReason })}>Cancel draft</Button>
            <Input className="max-w-sm" placeholder="Cancellation reason (required)" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          </> : null}
          {canApprove && selectedRun.status === "submitted" ? <Button pending={approve.isPending} onClick={() => approve.mutate({ runId: selectedRun.id })}>Approve payroll</Button> : null}
          {canApprove && selectedRun.status === "approved" ? <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); paid.mutate({ runId: selectedRun.id, reference: paymentReference }); }}><Field label="Bank payment reference"><Input required minLength={3} value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} /></Field><Button type="submit" pending={paid.isPending}>Record paid</Button></form> : null}
        </div>
        {detail.data ? <PayrollTable lines={detail.data.lines} status={selectedRun.status} periodStart={selectedRun.periodStart} periodEnd={selectedRun.periodEnd} canDraft={canDraft} runId={selectedRun.id} onManualApit={(input) => manualApit.mutate(input)} manualApitPending={manualApit.isPending} /> : <p className="py-8 text-center text-[13px] text-muted-foreground">Loading payroll lines…</p>}
      </Card> : null}
    </Page>
  );
}

function Total({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return <div className={`flex justify-between gap-3 border-b pb-2 ${strong ? "col-span-2 border-brand font-semibold" : ""}`}><dt className="text-muted-foreground">{label}</dt><dd className="font-mono">{asLkr(value)}</dd></div>;
}

function PayrollTable({ lines, status, periodStart, periodEnd, canDraft, runId, onManualApit, manualApitPending }: {
  lines: Line[];
  status: string;
  periodStart: string;
  periodEnd: string;
  canDraft: boolean;
  runId: string;
  onManualApit: (input: { runId: string; employeeId: string; amountCents: number; reason: string }) => void;
  manualApitPending: boolean;
}) {
  const [printLine, setPrintLine] = React.useState<Line | null>(null);
  function print(line: Line) {
    setPrintLine(line);
    window.setTimeout(() => window.print(), 200);
  }
  React.useEffect(() => {
    const closePrint = () => setPrintLine(null);
    window.addEventListener("afterprint", closePrint);
    return () => window.removeEventListener("afterprint", closePrint);
  }, []);

  return <>
    <p className="mb-3 text-[12px] text-muted-foreground">Amounts are LKR. Total earnings after staff EPF = gross earnings − staff EPF. APIT and other deductions reduce final net pay; company EPF and ETF do not.</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[1600px] text-left text-[12px]"><thead><tr className="border-b text-[10px] uppercase text-muted-foreground"><th className="p-2">Employee</th><th className="p-2 text-right">Gross earnings</th><th className="p-2 text-right">EPF base</th><th className="p-2 text-right">EPF staff deduction · 8%</th><th className="p-2 text-right">Total earnings after staff EPF</th><th className="p-2 text-right">APIT</th><th className="p-2 text-right">Other deductions</th><th className="p-2 text-right">Net pay</th><th className="p-2 text-right">EPF Company contribution · 12%</th><th className="p-2 text-right">ETF Company contribution · 3%</th><th className="p-2">Review / payslip</th></tr></thead><tbody>{lines.map((line) => {
      const snapshot = JSON.parse(line.breakdownJson) as Snapshot;
      return <tr key={line.id} className="border-b border-border/60 align-top"><td className="p-2"><span className="font-mono">{line.employeeCode}</span><span className="block font-medium">{line.employeeName}</span><span className="text-[10px] text-muted-foreground">{line.payBasis}</span></td><MoneyCell value={line.grossCents} /><MoneyCell value={line.epfBaseCents} /><MoneyCell value={line.employeeEpfCents} /><MoneyCell value={payrollPaySummary(line).earningsAfterStaffEpfCents} bold /><MoneyCell value={line.apitCents} /><MoneyCell value={line.otherDeductionsCents} /><MoneyCell value={line.netCents} bold /><MoneyCell value={line.employerEpfCents} /><MoneyCell value={line.employerEtfCents} />
        <td className="p-2"><div className="space-y-1">{snapshot.warnings.map((warning, index) => <p key={index} className="max-w-[300px] text-[10px] text-status-warn">{warning}</p>)}<div className="flex gap-1"><Button size="sm" variant="outline" onClick={() => print(line)}>Payslip</Button>{canDraft && status === "draft" ? <ManualApitForm line={line} runId={runId} onSave={onManualApit} pending={manualApitPending} /> : null}</div></div></td>
      </tr>;
    })}</tbody></table></div>
    {printLine ? <Payslip line={printLine} status={status} periodStart={periodStart} periodEnd={periodEnd} /> : null}
  </>;
}

function MoneyCell({ value, bold = false }: { value: number; bold?: boolean }) {
  return <td className={`whitespace-nowrap p-2 text-right font-mono ${bold ? "font-semibold" : ""}`}>{centsToLkr(value)}</td>;
}

function ManualApitForm({ line, runId, onSave, pending }: {
  line: Line;
  runId: string;
  onSave: (input: { runId: string; employeeId: string; amountCents: number; reason: string }) => void;
  pending: boolean;
}) {
  const [amount, setAmount] = React.useState(centsToLkr(line.apitCents));
  const [reason, setReason] = React.useState("");
  const cents = lkrToCents(amount);
  return <form className="flex flex-wrap items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (cents !== null) onSave({ runId, employeeId: line.employeeId, amountCents: cents, reason }); }}>
    <input aria-label={`Manual APIT for ${line.employeeCode}`} className="h-8 w-24 rounded border px-2 font-mono" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
    <input aria-label={`APIT review reference for ${line.employeeCode}`} className="h-8 w-32 rounded border px-2" placeholder="Reference" minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} />
    <Button size="sm" variant="ghost" type="submit" disabled={cents === null || reason.trim().length < 5} pending={pending}>Set APIT</Button>
  </form>;
}
