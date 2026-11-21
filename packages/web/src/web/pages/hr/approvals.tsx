import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { HrNavigation } from "./navigation";
import { currentMonthRange } from "./shared";

export default function HrApprovals() {
  const queryClient = useQueryClient();
  const { from, to } = currentMonthRange();
  const [note, setNote] = React.useState("");
  const [selectedAttendance, setSelectedAttendance] = React.useState<string[]>([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const attendance = useQuery({ ...orpc.hr.attendanceRows.queryOptions({ input: { from, to, approvalStatus: "pending" } }) });
  const leave = useQuery({ ...orpc.hr.leaveRequests.queryOptions({ input: { status: "pending", year: new Date().getFullYear() } }) });
  const attendanceRows = attendance.data ?? [];
  const attendanceIds = attendanceRows.map(({ attendance: row }) => row.id);
  const allAttendanceSelected = attendanceIds.length > 0 && attendanceIds.every((id) => selectedAttendance.includes(id));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.hr.attendanceRows.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.leaveRequests.key() });
  };
  const attendanceDecision = useMutation({ ...orpc.hr.decideAttendance.mutationOptions(), onSuccess: (result) => { setNotice(`${result.updated} attendance approval(s) updated.`); setSelectedAttendance([]); refresh(); } });
  const leaveDecision = useMutation({ ...orpc.hr.decideLeaveRequest.mutationOptions(), onSuccess: () => { setNotice("Leave decision recorded."); refresh(); } });
  const error = attendance.error ?? leave.error ?? attendanceDecision.error ?? leaveDecision.error;
  const toggleAllAttendance = (checked: boolean) => setSelectedAttendance(checked ? attendanceIds : []);

  return <Page title="Approvals" description="One HR inbox for attendance and leave requests. Decisions are audited and are used by payroll only after approval.">
    {notice ? <SuccessNote>{notice}</SuccessNote> : null}
    {error ? <ErrorNote>{apiMessage(error, "Approvals could not be loaded.")}</ErrorNote> : null}
    <HrNavigation />
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Pending attendance" description="Clock-in/out and manual hub entries awaiting HR decision.">
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="Decision note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Required approval note" /></Field>
          <Button size="sm" disabled={!selectedAttendance.length || !note.trim()} pending={attendanceDecision.isPending} onClick={() => attendanceDecision.mutate({ ids: selectedAttendance, decision: "approved", note })}>Approve {selectedAttendance.length || ""}</Button>
          <Button size="sm" variant="outline" disabled={!selectedAttendance.length || !note.trim()} pending={attendanceDecision.isPending} onClick={() => attendanceDecision.mutate({ ids: selectedAttendance, decision: "rejected", note })}>Reject</Button>
        </div>
        {attendanceRows.length ? <label className="mb-2 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-brand/40 bg-brand/5 px-3 py-2 text-[13px] font-medium">
          <input aria-label="Select all pending attendance" type="checkbox" checked={allAttendanceSelected} onChange={(e) => toggleAllAttendance(e.target.checked)} />
          <span>Select all pending attendance ({attendanceRows.length})</span>
        </label> : null}
        <div className="space-y-2">
          {attendanceRows.map(({ attendance: row, employeeCode, employeeName }) => <label key={row.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-border p-3 text-sm">
            <input type="checkbox" checked={selectedAttendance.includes(row.id)} onChange={() => setSelectedAttendance((current) => current.includes(row.id) ? current.filter((id) => id !== row.id) : [...current, row.id])} />
            <span className="flex-1"><span className="font-medium">{employeeCode} · {employeeName}</span><span className="block text-xs text-muted-foreground">{row.workDate} · {row.clockInAt ? new Date(row.clockInAt).toLocaleTimeString() : "—"} → {row.clockOutAt ? new Date(row.clockOutAt).toLocaleTimeString() : "—"}</span></span>
            <Badge variant="warn">pending</Badge>
          </label>)}
          {!attendance.isPending && !attendanceRows.length ? <p className="py-5 text-sm text-muted-foreground">No pending attendance.</p> : null}
        </div>
      </Card>
      <Card title="Pending leave" description="Prior leave and staff leave requests awaiting HR decision.">
        <div className="space-y-2">
          {(leave.data ?? []).map(({ request, employeeCode, employeeName, leaveTypeName }) => <div key={request.id} className="rounded-xl border border-border p-3"><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{employeeCode} · {employeeName}</p><p className="text-xs text-muted-foreground">{leaveTypeName} · {request.startsOn} → {request.endsOn} · {request.halfDays / 2} day(s)</p><p className="mt-2 text-sm">{request.reason}</p></div><Badge variant="warn">pending</Badge></div><div className="mt-3 flex gap-2"><Button size="sm" disabled={!note.trim()} pending={leaveDecision.isPending} onClick={() => leaveDecision.mutate({ requestId: request.id, decision: "approved", note })}>Approve</Button><Button size="sm" variant="outline" disabled={!note.trim()} pending={leaveDecision.isPending} onClick={() => leaveDecision.mutate({ requestId: request.id, decision: "rejected", note })}>Reject</Button></div></div>)}
          {!leave.isPending && !(leave.data ?? []).length ? <p className="py-5 text-sm text-muted-foreground">No pending leave requests.</p> : null}
        </div>
      </Card>
    </div>
  </Page>;
}
