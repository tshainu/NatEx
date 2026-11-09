import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiMessage, client, orpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { HrNavigation } from "./navigation";

function saveDownload(fileName: string, contentType: string, encoded: string) {
  const raw = atob(encoded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function HrPayslips() {
  const runs = useQuery({ ...orpc.hr.payrollRuns.queryOptions() });
  const eligibleRuns = (runs.data ?? []).filter((run) => run.status === "approved" || run.status === "paid");
  const [runId, setRunId] = React.useState("");
  const [employeeId, setEmployeeId] = React.useState("all");
  const [note, setNote] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (eligibleRuns.length && !eligibleRuns.some((run) => run.id === runId)) setRunId(eligibleRuns[0]!.id);
  }, [eligibleRuns, runId]);
  const detail = useQuery({
    ...orpc.hr.payrollRun.queryOptions({ input: { runId } }),
    enabled: Boolean(runId),
  });
  const exportFile = useMutation({
    mutationFn: (input: { runId: string; employeeIds?: string[] }) => client.hr.exportPayslips(input),
    onSuccess: (result) => {
      saveDownload(result.fileName, result.contentType, result.contentBase64);
      setNote(result.fileCount === 1 ? `Downloaded ${result.fileName}.` : `Downloaded ${result.fileCount} individual payslips in ${result.fileName}.`);
    },
  });
  const error = runs.error ?? detail.error ?? exportFile.error;
  const lines = detail.data?.lines ?? [];
  const selected = eligibleRuns.find((run) => run.id === runId);
  const hasSelection = employeeId === "all" ? lines.length > 0 : lines.some((line) => line.employeeId === employeeId);

  return <Page title="Payslips" description="Download payslips from saved, approved payroll snapshots. Draft and submitted payroll is not available here, and missing payroll records are never generated.">
    <HrNavigation />
    {note ? <SuccessNote>{note}</SuccessNote> : null}
    {error ? <ErrorNote>{apiMessage(error, "Payslips could not be loaded or downloaded.")}</ErrorNote> : null}
    <Card title="Download payslips" description="Choose an approved payroll period and one employee, or all employees in that payroll run. One employee downloads as a PDF; all employees download as a ZIP containing separate PDFs.">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-1 text-[13px] font-medium">Payroll period
          <select className="h-10 rounded-md border border-input bg-background px-3" value={runId} onChange={(event) => { setRunId(event.target.value); setEmployeeId("all"); setNote(null); }} disabled={runs.isPending || eligibleRuns.length === 0}>
            {eligibleRuns.length === 0 ? <option value="">No approved payroll periods</option> : null}
            {eligibleRuns.map((run) => <option key={run.id} value={run.id}>{run.periodStart} – {run.periodEnd} · {run.code} · {run.status}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-[13px] font-medium">Employee selection
          <select className="h-10 rounded-md border border-input bg-background px-3" value={employeeId} onChange={(event) => { setEmployeeId(event.target.value); setNote(null); }} disabled={!detail.data || lines.length === 0}>
            <option value="all">All employees in this payroll ({lines.length})</option>
            {lines.map((line) => <option key={line.employeeId} value={line.employeeId}>{line.employeeCode} · {line.employeeName}</option>)}
          </select>
        </label>
      </div>
      {selected ? <p className="mt-3 text-[12px] text-muted-foreground">Payroll status: {selected.status}. {lines.length} saved payslip record(s) for {selected.periodStart} through {selected.periodEnd}.</p> : null}
      {runId && detail.isPending ? <p className="mt-3 text-[13px] text-muted-foreground">Loading saved payroll records…</p> : null}
      {runId && detail.data && lines.length === 0 ? <p className="mt-3 text-[13px] text-muted-foreground">No payroll line exists for this period, so no payslip can be generated.</p> : null}
      <div className="mt-4"><Button disabled={!hasSelection || exportFile.isPending} pending={exportFile.isPending} onClick={() => {
        if (!runId) return;
        setNote(null);
        exportFile.mutate(employeeId === "all" ? { runId } : { runId, employeeIds: [employeeId] });
      }}>{employeeId === "all" ? "Download all as ZIP" : "Download employee PDF"}</Button></div>
    </Card>
  </Page>;
}
