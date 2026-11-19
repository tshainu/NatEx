import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { HrNavigation } from "./navigation";
import { todayInColombo } from "./shared";
import { useAuth } from "@/components/auth-provider";

const TYPES = ["resignation", "retirement", "end_of_contract", "probation_not_confirmed", "redundancy", "performance", "misconduct", "absence_abandonment", "medical", "mutual_separation", "death_in_service", "other"] as const;
const CHECKLIST = [
  ["identity", "Company ID returned"], ["uniform", "Uniform returned"], ["device", "Scanner / device returned"], ["keys", "Keys / access card returned"], ["vehicle", "Vehicle / fuel card cleared"], ["cod", "COD and cash balance cleared"], ["parcels", "Parcel and runsheet custody transferred"], ["documents", "Exit documents completed"], ["it", "Official account access disabled"], ["finance", "Finance clearance completed"],
] as const;

const label = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const emptyChecklist = () => Object.fromEntries(CHECKLIST.map(([key]) => [key, false]));
type RehireDecision = "eligible" | "not_eligible" | "eligible_with_approval" | "not_assessed";

export default function HrTerminations() {
  const queryClient = useQueryClient();
  const session = useAuth().session;
  const canDecide = Boolean(session?.user.roles?.includes("admin") || session?.user.role === "admin");
  const [employeeId, setEmployeeId] = React.useState("");
  const [terminationType, setTerminationType] = React.useState<typeof TYPES[number]>("resignation");
  const [noticeGivenOn, setNoticeGivenOn] = React.useState("");
  const [lastWorkingOn, setLastWorkingOn] = React.useState(todayInColombo());
  const [reason, setReason] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [rehireDecision, setRehireDecision] = React.useState<RehireDecision>("not_assessed");
  const [checklist, setChecklist] = React.useState<Record<string, boolean>>(emptyChecklist);
  const [decisionNote, setDecisionNote] = React.useState("");
  const employees = useQuery({ ...orpc.hr.employees.queryOptions({ input: { status: "active", limit: 5000 } }) });
  const terminations = useQuery({ ...orpc.hr.terminations.queryOptions() });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.hr.terminations.key() });
  const create = useMutation({ ...orpc.hr.createTermination.mutationOptions(), onSuccess: () => { setReason(""); setNotes(""); setChecklist(emptyChecklist()); setNotice("Termination request created as a draft."); refresh(); } });
  const submit = useMutation({ ...orpc.hr.submitTermination.mutationOptions(), onSuccess: () => { setNotice("Termination request submitted for approval."); refresh(); } });
  const decide = useMutation({ ...orpc.hr.decideTermination.mutationOptions(), onSuccess: () => { setDecisionNote(""); setNotice("Termination decision recorded."); refresh(); } });
  const complete = useMutation({ ...orpc.hr.completeTermination.mutationOptions(), onSuccess: () => { setNotice("Termination completed and the employee was moved to inactive."); refresh(); void queryClient.invalidateQueries({ queryKey: orpc.hr.employees.key() }); } });
  const checklistMutation = useMutation({ ...orpc.hr.updateTerminationChecklist.mutationOptions(), onSuccess: () => { setNotice("Exit checklist updated."); refresh(); } });
  const [notice, setNotice] = React.useState<string | null>(null);
  const error = employees.error ?? terminations.error ?? create.error ?? submit.error ?? decide.error ?? complete.error ?? checklistMutation.error;
  const activeEmployees = employees.data ?? [];

  return <Page title="Terminations" description="A controlled, audited exit process for notice, approval, clearance, rehire decisions, and final employment closure.">
    {notice ? <SuccessNote>{notice}</SuccessNote> : null}
    {error ? <ErrorNote>{apiMessage(error, "The termination workflow could not be loaded or saved.")}</ErrorNote> : null}
    <HrNavigation />

    <Card className="border-2 border-brand/25 shadow-sm" title="Start termination request" description="The employee remains active until an approved request is completed. Use the exit checklist to coordinate HR, Finance, Operations, and IT clearance.">
      <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); create.mutate({ employeeId, terminationType, noticeGivenOn: noticeGivenOn || null, lastWorkingOn, reason, notes: notes || null, rehireDecision, checklist }); }}>
        <div className="grid gap-4 rounded-2xl border border-border bg-background p-4 shadow-sm md:grid-cols-2 xl:grid-cols-3">
          <Field label="Employee"><select required className="h-9 rounded-md border border-input bg-background px-3 text-[13px]" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">Select active employee</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.fullName} · {employee.department}</option>)}</select></Field>
          <Field label="Termination type"><select className="h-9 rounded-md border border-input bg-background px-3 text-[13px]" value={terminationType} onChange={(event) => setTerminationType(event.target.value as typeof TYPES[number])}>{TYPES.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></Field>
          <Field label="Notice given on"><Input type="date" value={noticeGivenOn} onChange={(event) => setNoticeGivenOn(event.target.value)} /></Field>
          <Field label="Last working date"><Input required type="date" value={lastWorkingOn} onChange={(event) => setLastWorkingOn(event.target.value)} /></Field>
          <Field label="Rehire decision"><select className="h-9 rounded-md border border-input bg-background px-3 text-[13px]" value={rehireDecision} onChange={(event) => setRehireDecision(event.target.value as RehireDecision)}><option value="not_assessed">Not assessed</option><option value="eligible">Eligible for rehire</option><option value="eligible_with_approval">Eligible with approval</option><option value="not_eligible">Not eligible for rehire</option></select></Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2"><Field label="Reason" hint="Use factual, reviewable wording."><Textarea required minLength={5} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} /></Field><Field label="HR notes"><Textarea maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} /></Field></div>
        <div className="rounded-2xl border border-border bg-muted/20 p-4"><div className="mb-3"><h3 className="text-sm font-semibold">Exit checklist</h3><p className="mt-1 text-xs text-muted-foreground">Mark items already cleared. Remaining items can be updated from the request below.</p></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{CHECKLIST.map(([key, text]) => <label key={key} className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs"><input type="checkbox" checked={Boolean(checklist[key])} onChange={(event) => setChecklist((current) => ({ ...current, [key]: event.target.checked }))} />{text}</label>)}</div></div>
        <div className="flex justify-end"><Button type="submit" pending={create.isPending}>Create draft request</Button></div>
      </form>
    </Card>

    <Card title="Termination desk" description="Track every request from draft through approval and completion.">
      <div className="space-y-3">{(terminations.data ?? []).map(({ termination, employee }) => <TerminationRow key={termination.id} termination={termination} employee={employee} canDecide={canDecide} decisionNote={decisionNote} setDecisionNote={setDecisionNote} onSubmit={() => submit.mutate({ id: termination.id })} onDecide={(decision) => decide.mutate({ id: termination.id, decision, decisionNote: decisionNote || (decision === "approved" ? "Approved after HR review." : "Returned for correction.") })} onComplete={() => complete.mutate({ id: termination.id })} onChecklist={(next) => checklistMutation.mutate({ id: termination.id, checklist: next })} />)}{!terminations.isPending && !(terminations.data ?? []).length ? <p className="py-8 text-center text-sm text-muted-foreground">No termination requests yet.</p> : null}</div>
    </Card>
  </Page>;
}

function TerminationRow({ termination, employee, canDecide, decisionNote, setDecisionNote, onSubmit, onDecide, onComplete, onChecklist }: { termination: any; employee: any; canDecide: boolean; decisionNote: string; setDecisionNote: (value: string) => void; onSubmit: () => void; onDecide: (decision: "approved" | "rejected") => void; onComplete: () => void; onChecklist: (next: Record<string, boolean>) => void }) {
  const [open, setOpen] = React.useState(false);
  const completed = Object.values(termination.checklist as Record<string, boolean>).filter(Boolean).length;
  return <div className="rounded-2xl border border-border bg-background p-4 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-semibold">{employee.employeeCode} · {employee.fullName}</p><p className="mt-1 text-xs text-muted-foreground">{label(termination.terminationType)} · Last working {termination.lastWorkingOn} · {employee.department}</p></div><div className="flex items-center gap-2"><Badge variant={termination.status === "approved" || termination.status === "completed" ? "good" : termination.status === "submitted" ? "brand" : termination.status === "rejected" ? "outline" : "warn"}>{label(termination.status)}</Badge><span className="text-xs text-muted-foreground">{completed}/{CHECKLIST.length} cleared</span><Button size="sm" variant="outline" onClick={() => setOpen(!open)}>{open ? "Hide" : "Review"}</Button></div></div>{open ? <div className="mt-4 space-y-4 border-t border-border pt-4"><div className="grid gap-3 text-xs md:grid-cols-3"><div><p className="text-muted-foreground">Reason</p><p className="mt-1 whitespace-pre-wrap">{termination.reason}</p></div><div><p className="text-muted-foreground">Notice given</p><p className="mt-1">{termination.noticeGivenOn ?? "Not recorded"}</p></div><div><p className="text-muted-foreground">Rehire decision</p><p className="mt-1">{label(termination.rehireDecision)}</p></div></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{CHECKLIST.map(([key, text]) => <label key={key} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs"><input type="checkbox" checked={Boolean(termination.checklist[key])} onChange={(event) => onChecklist({ ...termination.checklist, [key]: event.target.checked })} />{text}</label>)}</div><div className="flex flex-wrap items-end gap-2">{termination.status === "draft" ? <Button size="sm" onClick={onSubmit}>Submit for approval</Button> : null}{termination.status === "submitted" && canDecide ? <><Field label="Decision note"><Input value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} placeholder="Review note" /></Field><Button size="sm" onClick={() => onDecide("approved")}>Approve</Button><Button size="sm" variant="outline" onClick={() => onDecide("rejected")}>Return</Button></> : null}{termination.status === "approved" ? <Button size="sm" onClick={onComplete}>Complete termination</Button> : null}</div></div> : null}</div>;
}
