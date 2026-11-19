import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { Badge } from "@/components/ui/badge";
import { HR_CONTROL_CLASS, todayInColombo } from "./shared";
import { HrNavigation } from "./navigation";

export default function HrCalendar() {
  const queryClient = useQueryClient();
  const year = Number(todayInColombo().slice(0, 4));
  const [date, setDate] = React.useState(`${year}-12-25`);
  const [name, setName] = React.useState("");
  const [scope, setScope] = React.useState<"company" | "hub" | "branch">("company");
  const [scopeId, setScopeId] = React.useState("");
  const [otAllowed, setOtAllowed] = React.useState(false);
  const [compulsoryLeave, setCompulsoryLeave] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const holidays = useQuery({ ...orpc.hr.holidays.queryOptions({ input: { year } }) });
  const payouts = useQuery({ ...orpc.hr.leavePayoutRuns.queryOptions() });
  const save = useMutation({ ...orpc.hr.saveHoliday.mutationOptions(), onSuccess: () => { setNote("Holiday saved."); setName(""); void queryClient.invalidateQueries({ queryKey: orpc.hr.holidays.key() }); } });
  const generate = useMutation({ ...orpc.hr.generateLeavePayout.mutationOptions(), onSuccess: () => { setNote("Leave payout snapshot generated."); void queryClient.invalidateQueries({ queryKey: orpc.hr.leavePayoutRuns.key() }); } });
  const submit = useMutation({ ...orpc.hr.submitLeavePayout.mutationOptions(), onSuccess: () => { setNote("Payout submitted for approval."); void queryClient.invalidateQueries({ queryKey: orpc.hr.leavePayoutRuns.key() }); } });
  const approve = useMutation({ ...orpc.hr.approveLeavePayout.mutationOptions(), onSuccess: () => { setNote("Payout approval updated."); void queryClient.invalidateQueries({ queryKey: orpc.hr.leavePayoutRuns.key() }); } });
  const error = holidays.error ?? payouts.error ?? save.error ?? generate.error ?? submit.error ?? approve.error;
  return <Page title="Calendar & leave payout" description="Configure holiday work rules and generate the separate year-end unused annual-leave payable. Compulsory holidays are unpaid and do not consume leave balance.">
    {note ? <SuccessNote>{note}</SuccessNote> : null}
    {error ? <ErrorNote>{apiMessage(error, "Calendar or payout data could not be loaded.")}</ErrorNote> : null}
    <HrNavigation />
    <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
      <Card title="Add holiday rule" description="A holiday can be global, hub-scoped, or branch-scoped. Every worked hour is OT when OT is allowed, using the employee scheme.">
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); save.mutate({ holidayDate: date, name, scope, scopeId: scope === "company" ? undefined : scopeId, otAllowed, compulsoryLeave, active: true }); }}>
          <Field label="Date"><Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Holiday name"><Input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="Public holiday" /></Field>
          <Field label="Scope"><select className={HR_CONTROL_CLASS} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}><option value="company">Company</option><option value="hub">Hub</option><option value="branch">Branch</option></select></Field>
          {scope !== "company" ? <Field label="Hub/branch ID"><Input required value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder="Paste location ID" /></Field> : null}
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={otAllowed} onChange={(e) => setOtAllowed(e.target.checked)} /> OT allowed</label>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={compulsoryLeave} onChange={(e) => setCompulsoryLeave(e.target.checked)} /> Compulsory leave (unpaid; no leave deduction)</label>
          <Button type="submit" pending={save.isPending}>Save holiday</Button>
        </form>
      </Card>
      <Card title={`Holiday calendar · ${year}`} description="The most-specific active rule applies to an employee's branch.">
        <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Date</th><th className="p-2">Name</th><th className="p-2">Scope</th><th className="p-2">Rules</th></tr></thead><tbody>{(holidays.data ?? []).map((holiday) => <tr key={holiday.id} className="border-b border-border/60"><td className="p-2 font-mono">{holiday.holidayDate}</td><td className="p-2">{holiday.name}</td><td className="p-2">{holiday.scope}{holiday.scopeId ? ` · ${holiday.scopeId}` : ""}</td><td className="p-2 flex gap-1"><Badge variant={holiday.otAllowed ? "good" : "outline"}>{holiday.otAllowed ? "OT" : "No OT"}</Badge>{holiday.compulsoryLeave ? <Badge variant="warn">Compulsory · unpaid</Badge> : null}</td></tr>)}</tbody></table></div>
      </Card>
    </div>
    <Card title="Year-end unused annual leave payable" description="Available from December 27. Formula: unused annual-leave days × basic monthly salary ÷ 25. The result is a separate auditable payable workflow.">
      <div className="mb-4 flex flex-wrap gap-2"><Button onClick={() => generate.mutate({ year: year - 1 })} pending={generate.isPending}>Generate {year - 1} payout</Button></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Year</th><th className="p-2">Employees</th><th className="p-2">Total</th><th className="p-2">Status</th><th className="p-2">Actions</th></tr></thead><tbody>{(payouts.data ?? []).map((run) => <tr key={run.id} className="border-b border-border/60"><td className="p-2 font-mono">{run.year}</td><td className="p-2">{run.employeeCount}</td><td className="p-2 font-mono">LKR {(run.totalCents / 100).toLocaleString("en-LK", { minimumFractionDigits: 2 })}</td><td className="p-2"><Badge variant={run.status === "approved" || run.status === "paid" ? "good" : "warn"}>{run.status}</Badge></td><td className="p-2 flex gap-1">{run.status === "draft" ? <Button size="sm" onClick={() => submit.mutate({ runId: run.id })}>Submit</Button> : null}{run.status === "submitted" ? <Button size="sm" onClick={() => approve.mutate({ runId: run.id, decision: "approved" })}>Approve</Button> : null}</td></tr>)}</tbody></table></div>
    </Card>
  </Page>;
}
