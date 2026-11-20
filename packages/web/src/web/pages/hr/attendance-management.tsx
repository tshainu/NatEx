import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { useAuth } from "@/components/auth-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { HrNavigation } from "./navigation";
import { currentMonthRange, todayInColombo } from "./shared";

function localDateTime(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function todayDateTime(value: string) {
  return value ? localDateTime(`${todayInColombo()}T${value}:00`) : null;
}

export default function HrAttendanceManagement() {
  const { session } = useAuth();
  const roles = session?.user.roles ?? (session ? [session.user.role] : []);
  const isHubManager = roles.includes("ops") && !roles.some((role) => ["hr", "admin", "super_admin", "nos_admin"].includes(role));
  const queryClient = useQueryClient();
  const range = currentMonthRange();
  const [from, setFrom] = React.useState(range.from);
  const [to, setTo] = React.useState(range.to);
  const [status, setStatus] = React.useState<"pending" | "approved" | "rejected" | "">("pending");
  const [employeeId, setEmployeeId] = React.useState("");
  const [clockInTime, setClockInTime] = React.useState("");
  const [clockOutTime, setClockOutTime] = React.useState("");
  const [attendanceStatus, setAttendanceStatus] = React.useState<"present" | "absent" | "leave" | "off_duty">("present");
  const [note, setNote] = React.useState("");
  const [leaveTypeId, setLeaveTypeId] = React.useState("");
  const [leaveDay, setLeaveDay] = React.useState(todayInColombo());
  const [leaveHalfDays, setLeaveHalfDays] = React.useState("1");
  const [leaveReason, setLeaveReason] = React.useState("");
  const [selected, setSelected] = React.useState<string[]>([]);
  const [decisionNote, setDecisionNote] = React.useState("");
  const [notice, setNotice] = React.useState<string | null>(null);

  const hrEmployees = useQuery({ ...orpc.hr.employees.queryOptions({ input: { status: "active", limit: 5000 } }), enabled: !isHubManager });
  const hubEmployees = useQuery({ ...orpc.hr.hubEmployees.queryOptions(), enabled: isHubManager });
  const employeeList = isHubManager ? (hubEmployees.data ?? []) : (hrEmployees.data ?? []);
  const leaveTypes = useQuery({ ...(isHubManager ? orpc.hr.hubLeaveTypes.queryOptions() : orpc.hr.leaveTypes.queryOptions()) });
  const rows = useQuery({
    ...orpc.hr.attendanceRows.queryOptions({ input: { from, to, employeeId: employeeId || undefined, approvalStatus: status || undefined } }),
    enabled: !isHubManager,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.hr.attendanceRows.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.hubEmployees.key() });
  };
  const save = useMutation({
    ...orpc.hr.saveManualAttendance.mutationOptions(),
    onSuccess: () => { setNotice("Manual attendance saved as approval pending."); refresh(); },
  });
  const applyLeave = useMutation({
    ...orpc.hr.hubApplyLeave.mutationOptions(),
    onSuccess: () => { setNotice("Leave request sent to HR for approval."); setLeaveReason(""); refresh(); },
  });
  const decide = useMutation({
    ...orpc.hr.decideAttendance.mutationOptions(),
    onSuccess: (result) => { setNotice(`${result.updated} attendance row(s) marked ${result.decision}.`); setSelected([]); refresh(); },
  });
  const error = (isHubManager ? hubEmployees.error : hrEmployees.error) ?? (isHubManager ? null : rows.error) ?? save.error ?? applyLeave.error ?? decide.error;
  const data = isHubManager ? [] : (rows.data ?? []);
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return (
    <Page
      title={isHubManager ? "Attendance desk" : "Attendance management"}
      description={isHubManager ? "Record attendance and submit leave requests for active employees in your assigned hub and branches." : "Hub administrators record attendance after a shift; HR reviews, filters, and approves attendance before payroll uses it."}
    >
      {notice ? <SuccessNote>{notice}</SuccessNote> : null}
      {error ? <ErrorNote>{apiMessage(error, "Attendance could not be loaded or saved.")}</ErrorNote> : null}
      {!isHubManager ? <HrNavigation /> : null}

      {!isHubManager ? (
        <Card title="Attendance filters" description="The regular office window is 08:30–17:00. Short leave cutoff is 09:30; half-day cutoff is 12:30.">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <Field label="Employee"><select className="h-9 rounded-md border border-input bg-background px-3 text-[13px]" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}><option value="">All employees</option>{employeeList.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.fullName}</option>)}</select></Field>
            <Field label="Approval"><select className="h-9 rounded-md border border-input bg-background px-3 py-2 text-[13px]" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="">All</option></select></Field>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-2 border-brand/25" title="Add manual attendance" description="Every manual entry is approval pending until HR decides.">
          <form className="grid gap-3 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate({ employeeId, workDate: todayInColombo(), clockInAt: todayDateTime(clockInTime), clockOutAt: todayDateTime(clockOutTime), attendanceStatus, note: note || null }); }}>
            <Field label="Employee"><select required className="h-9 rounded-md border border-input bg-background px-3 py-2 text-[13px]" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}><option value="">Select employee</option>{employeeList.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.fullName}</option>)}</select></Field>
            <Field label="Clock in"><Input type="time" step="60" value={clockInTime} onChange={(e) => setClockInTime(e.target.value)} /></Field>
            <Field label="Clock out"><Input type="time" step="60" value={clockOutTime} onChange={(e) => setClockOutTime(e.target.value)} /></Field>
            <Field label="Attendance status"><select className="h-9 rounded-md border border-input bg-background px-3 py-2 text-[13px]" value={attendanceStatus} onChange={(e) => setAttendanceStatus(e.target.value as typeof attendanceStatus)}><option value="present">Present</option><option value="absent">Absent</option><option value="leave">Leave</option><option value="off_duty">Off duty</option></select></Field>
            <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
            <Button type="submit" pending={save.isPending}>Save as pending</Button>
          </form>
        </Card>

        <Card title="Apply leave on behalf" description="Submit a prior leave request for a staff member; HR receives it as pending approval.">
          <form className="grid gap-3 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); applyLeave.mutate({ employeeId, leaveTypeId, startsOn: leaveDay, endsOn: leaveDay, halfDays: Number(leaveHalfDays), reason: leaveReason }); }}>
            <Field label="Employee"><select required className="h-9 rounded-md border border-input bg-background px-3 py-2 text-[13px]" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}><option value="">Select employee</option>{employeeList.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.fullName}</option>)}</select></Field>
            <Field label="Leave type"><select required className="h-9 rounded-md border border-input bg-background px-3 py-2 text-[13px]" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)}><option value="">Select leave type</option>{(leaveTypes.data ?? []).map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></Field>
            <Field label="Day"><Input type="date" required value={leaveDay} onChange={(e) => setLeaveDay(e.target.value)} /></Field>
            <Field label="Half-day units"><Input type="number" min="1" value={leaveHalfDays} onChange={(e) => setLeaveHalfDays(e.target.value)} /></Field>
            <Field label="Reason"><Textarea required value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} /></Field>
            <Button type="submit" pending={applyLeave.isPending}>Send to HR</Button>
          </form>
        </Card>
      </div>

      {!isHubManager ? (
        <Card title="Attendance approvals" description="Select one or more rows for a single HR decision.">
          <div className="mb-3 flex flex-wrap items-end gap-2"><Field label="Decision note"><Input value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} placeholder="Approval or rejection note" /></Field><Button size="sm" disabled={!selected.length || !decisionNote.trim()} pending={decide.isPending} onClick={() => decide.mutate({ ids: selected, decision: "approved", note: decisionNote })}>Approve selected ({selected.length})</Button><Button size="sm" variant="outline" disabled={!selected.length || !decisionNote.trim()} pending={decide.isPending} onClick={() => decide.mutate({ ids: selected, decision: "rejected", note: decisionNote })}>Reject selected</Button></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[1050px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Select</th><th className="p-2">Date</th><th className="p-2">Employee</th><th className="p-2">Clock in</th><th className="p-2">Clock out</th><th className="p-2">Regular</th><th className="p-2">OT</th><th className="p-2">Source</th><th className="p-2">Status</th></tr></thead><tbody>{data.map(({ attendance, employeeCode, employeeName, department }) => <tr key={attendance.id} className="border-b border-border/60"><td className="p-2"><input type="checkbox" checked={selected.includes(attendance.id)} onChange={() => toggle(attendance.id)} /></td><td className="p-2 font-mono">{attendance.workDate}</td><td className="p-2"><span className="font-mono">{employeeCode}</span> · {employeeName}<span className="block text-[11px] text-muted-foreground">{department}</span></td><td className="p-2">{attendance.clockInAt ? new Date(attendance.clockInAt).toLocaleTimeString() : "—"}</td><td className="p-2">{attendance.clockOutAt ? new Date(attendance.clockOutAt).toLocaleTimeString() : "—"}</td><td className="p-2">{(attendance.regularMinutes / 60).toFixed(2)} h</td><td className="p-2">{(attendance.overtimeMinutes / 60).toFixed(2)} h</td><td className="p-2">{attendance.source}</td><td className="p-2"><Badge variant={attendance.approvalStatus === "approved" ? "good" : attendance.approvalStatus === "pending" ? "warn" : "outline"}>{attendance.approvalStatus}</Badge></td></tr>)}</tbody></table>{!rows.isPending && !data.length ? <p className="py-7 text-center text-sm text-muted-foreground">No attendance rows match these filters.</p> : null}</div>
        </Card>
      ) : null}
    </Page>
  );
}
