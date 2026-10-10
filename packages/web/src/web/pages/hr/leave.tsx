import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { HR_CONTROL_CLASS, todayInColombo } from "./shared";
import { HrNavigation } from "./navigation";

export default function HrLeave() {
  const queryClient = useQueryClient();
  const thisYear = Number(todayInColombo().slice(0, 4));
  const [employeeId, setEmployeeId] = React.useState("");
  const [leaveTypeId, setLeaveTypeId] = React.useState("");
  const [startsOn, setStartsOn] = React.useState(todayInColombo());
  const [endsOn, setEndsOn] = React.useState(todayInColombo());
  const [halfDays, setHalfDays] = React.useState("2");
  const [reason, setReason] = React.useState("");
  const [decisionNote, setDecisionNote] = React.useState("");
  const [adjustEmployeeId, setAdjustEmployeeId] = React.useState("");
  const [adjustTypeId, setAdjustTypeId] = React.useState("");
  const [adjustYear, setAdjustYear] = React.useState(String(thisYear));
  const [adjustHalfDays, setAdjustHalfDays] = React.useState("");
  const [adjustReason, setAdjustReason] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const employees = useQuery({ ...orpc.hr.employees.queryOptions({ input: { limit: 500 } }) });
  const types = useQuery({ ...orpc.hr.leaveTypes.queryOptions() });
  const requests = useQuery({ ...orpc.hr.leaveRequests.queryOptions({ input: { year: thisYear } }) });
  const balances = useQuery({ ...orpc.hr.leaveBalances.queryOptions({ input: { year: thisYear } }) });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.hr.leaveRequests.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.leaveBalances.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.leaveTypes.key() });
  };
  const create = useMutation({ ...orpc.hr.createLeaveRequest.mutationOptions(), onSuccess: () => { setNote("Leave request was recorded and is awaiting a decision."); setReason(""); refresh(); } });
  const decide = useMutation({ ...orpc.hr.decideLeaveRequest.mutationOptions(), onSuccess: (row) => { setNote(`Leave request ${row.status}.`); refresh(); } });
  const saveType = useMutation({ ...orpc.hr.saveLeaveType.mutationOptions(), onSuccess: () => { setNote("Leave policy was updated."); refresh(); } });
  const adjust = useMutation({ ...orpc.hr.adjustLeaveBalance.mutationOptions(), onSuccess: () => { setNote("Opening/carry-over balance adjustment was added to the audit trail."); setAdjustHalfDays(""); setAdjustReason(""); refresh(); } });

  const error = employees.error ?? types.error ?? requests.error ?? balances.error ?? create.error ?? decide.error ?? saveType.error ?? adjust.error;
  const activeEmployees = (employees.data ?? []).filter((employee) => employee.status === "active");
  const activeTypes = (types.data ?? []).filter((type) => type.active);

  return (
    <Page title="Leave management" description="Configure NatEx leave categories and entitlements, enter leave on behalf of employees, review decisions, and maintain opening balances. Entitlements are deliberately configurable; no statutory accrual has been assumed.">
      {note ? <SuccessNote>{note}</SuccessNote> : null}
      {error ? <ErrorNote>{apiMessage(error, "Leave data could not be loaded or saved.")}</ErrorNote> : null}
      <HrNavigation />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Record leave" description="Requests use half-day units. Paid leave checks the employee's available balance before approval.">
          <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); create.mutate({ employeeId, leaveTypeId, startsOn, endsOn, halfDays: Number(halfDays), reason }); }}>
            <Field label="Employee"><select required className={HR_CONTROL_CLASS} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}><option value="">Select employee</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.fullName}</option>)}</select></Field>
            <Field label="Leave type"><select required className={HR_CONTROL_CLASS} value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)}><option value="">Select leave type</option>{activeTypes.map((type) => <option key={type.id} value={type.id}>{type.name} · {type.paid ? "paid" : "unpaid"}</option>)}</select></Field>
            <Field label="Start date"><Input required type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></Field>
            <Field label="End date"><Input required type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></Field>
            <Field label="Duration (half-day units)" hint="Enter 1 for a half-day, 2 for one full day."><Input type="number" required min="1" max="730" step="1" value={halfDays} onChange={(e) => setHalfDays(e.target.value)} /></Field>
            <Field label="Reason"><Input required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="md:col-span-2"><Button type="submit" pending={create.isPending}>Create leave request</Button></div>
          </form>
        </Card>
        <Card title="Balance adjustment" description="Use for opening balance or approved carry-over corrections. Every change is permanent and attributed to the HR user who recorded it.">
          <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); adjust.mutate({ employeeId: adjustEmployeeId, leaveTypeId: adjustTypeId, leaveYear: Number(adjustYear), halfDaysDelta: Number(adjustHalfDays), reason: adjustReason }); }}>
            <Field label="Employee"><select required className={HR_CONTROL_CLASS} value={adjustEmployeeId} onChange={(e) => setAdjustEmployeeId(e.target.value)}><option value="">Select employee</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.fullName}</option>)}</select></Field>
            <Field label="Leave category"><select required className={HR_CONTROL_CLASS} value={adjustTypeId} onChange={(e) => setAdjustTypeId(e.target.value)}><option value="">Select type</option>{activeTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></Field>
            <Field label="Leave year"><Input type="number" min="2020" max="2100" value={adjustYear} onChange={(e) => setAdjustYear(e.target.value)} /></Field>
            <Field label="Adjustment (half-day units)" hint="Positive adds balance; negative reduces it."><Input required type="number" step="1" min="-1000" max="1000" value={adjustHalfDays} onChange={(e) => setAdjustHalfDays(e.target.value)} /></Field>
            <Field label="Reason / source document" className="md:col-span-2"><Input required minLength={5} maxLength={500} value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} /></Field>
            <div className="md:col-span-2"><Button type="submit" variant="outline" pending={adjust.isPending}>Add balance adjustment</Button></div>
          </form>
        </Card>
      </div>

      <Card title="Leave policy categories" description="The four starter categories have zero entitlement until HR configures the applicable NatEx policy. Paid/unpaid treatment directly affects payroll leave proration.">
        <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Category</th><th className="p-2">Code</th><th className="p-2">Paid?</th><th className="p-2">Annual entitlement (days)</th><th className="p-2">Status</th><th className="p-2"><span className="sr-only">Actions</span></th></tr></thead><tbody>{(types.data ?? []).map((type) => <LeaveTypeRow key={type.id} type={type} onSave={(data) => saveType.mutate(data)} pending={saveType.isPending} />)}</tbody></table></div>
      </Card>

      <Card title={`Leave balances · ${thisYear}`} description="Paid leave is shown in half-day units. Approved leave is deducted; pending leave is not yet used.">
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Employee</th><th className="p-2">Leave type</th><th className="p-2">Entitled</th><th className="p-2">Adjustment</th><th className="p-2">Used</th><th className="p-2">Available</th></tr></thead><tbody>{(balances.data ?? []).filter((row) => row.paid).map((row) => <tr key={`${row.employeeId}-${row.leaveTypeId}`} className="border-b border-border/60"><td className="p-2 font-mono">{row.employeeCode}</td><td className="p-2">{row.leaveType}</td><td className="p-2">{row.entitlementHalfDays / 2} d</td><td className="p-2">{row.adjustmentHalfDays / 2} d</td><td className="p-2">{row.usedHalfDays / 2} d</td><td className="p-2 font-semibold">{row.availableHalfDays / 2} d</td></tr>)}</tbody></table>{!balances.isPending && (balances.data ?? []).filter((row) => row.paid).length === 0 ? <p className="py-6 text-center text-[13px] text-muted-foreground">No paid leave balances to display.</p> : null}</div>
      </Card>

      <Card title="Leave requests" description="Pending requests do not consume paid balance until approved.">
        <Field label="Decision note" hint="Required by the API for approval or rejection."><Input maxLength={500} value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} placeholder="Decision reason" /></Field>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[900px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Employee</th><th className="p-2">Category</th><th className="p-2">Dates</th><th className="p-2">Duration</th><th className="p-2">Reason</th><th className="p-2">Status</th><th className="p-2">Decision</th></tr></thead><tbody>{(requests.data ?? []).map(({ request, employeeCode, employeeName, leaveTypeName, paid }) => <tr key={request.id} className="border-b border-border/60"><td className="p-2"><span className="font-mono">{employeeCode}</span><span className="block">{employeeName}</span></td><td className="p-2">{leaveTypeName}<span className="block text-[11px] text-muted-foreground">{paid ? "paid" : "unpaid"}</span></td><td className="p-2 font-mono">{request.startsOn} – {request.endsOn}</td><td className="p-2">{request.halfDays / 2} d</td><td className="p-2">{request.reason}</td><td className="p-2"><Badge variant={request.status === "approved" ? "good" : request.status === "pending" ? "warn" : "outline"}>{request.status}</Badge></td><td className="p-2">{request.status === "pending" ? <div className="flex gap-1"><Button size="sm" disabled={!decisionNote.trim()} pending={decide.isPending} onClick={() => decide.mutate({ requestId: request.id, decision: "approved", note: decisionNote })}>Approve</Button><Button size="sm" variant="outline" disabled={!decisionNote.trim()} pending={decide.isPending} onClick={() => decide.mutate({ requestId: request.id, decision: "rejected", note: decisionNote })}>Reject</Button></div> : request.decisionNote ?? "—"}</td></tr>)}</tbody></table>{!requests.isPending && (requests.data?.length ?? 0) === 0 ? <p className="py-6 text-center text-[13px] text-muted-foreground">No leave requests for this year.</p> : null}</div>
      </Card>
    </Page>
  );
}

type LeaveType = { id: string; code: string; name: string; paid: boolean; annualEntitlementHalfDays: number; active: boolean };

function LeaveTypeRow({ type, onSave, pending }: {
  type: LeaveType;
  onSave: (data: { id: string; code: string; name: string; paid: boolean; annualEntitlementHalfDays: number; active: boolean }) => void;
  pending: boolean;
}) {
  const [name, setName] = React.useState(type.name);
  const [entitlement, setEntitlement] = React.useState(String(type.annualEntitlementHalfDays / 2));
  const [paid, setPaid] = React.useState(type.paid);
  const [active, setActive] = React.useState(type.active);
  return <tr className="border-b border-border/60"><td className="p-2"><Input aria-label={`Leave category name for ${type.code}`} value={name} onChange={(e) => setName(e.target.value)} /></td><td className="p-2 font-mono">{type.code}</td><td className="p-2"><label className="flex items-center gap-1"><input type="checkbox" aria-label={`${type.code} leave is paid`} checked={paid} onChange={(e) => setPaid(e.target.checked)} /> paid</label></td><td className="p-2"><Input aria-label={`Annual entitlement days for ${type.code}`} type="number" min="0" max="500" step="0.5" value={entitlement} onChange={(e) => setEntitlement(e.target.value)} /></td><td className="p-2"><label className="flex items-center gap-1"><input type="checkbox" aria-label={`${type.code} leave category is active`} checked={active} onChange={(e) => setActive(e.target.checked)} /> active</label></td><td className="p-2"><Button size="sm" variant="outline" pending={pending} onClick={() => onSave({ id: type.id, code: type.code, name, paid, annualEntitlementHalfDays: Math.round(Number(entitlement) * 2), active })}>Save</Button></td></tr>;
}
