import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { HR_CONTROL_CLASS, todayInColombo } from "./shared";
import { HrNavigation } from "./navigation";
import { Dialog } from "@/components/ui/dialog";

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
  const [balanceBranchId, setBalanceBranchId] = React.useState("");
  const [balanceHubId, setBalanceHubId] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [reviewEmployeeId, setReviewEmployeeId] = React.useState<string | null>(null);
  const employees = useQuery({ ...orpc.hr.employees.queryOptions({ input: { limit: 500 } }) });
  const branches = useQuery({ ...orpc.identity.listBranches.queryOptions({ input: { includeInactive: true } }) });
  const types = useQuery({ ...orpc.hr.leaveTypes.queryOptions() });
  // Pending approvals must not disappear merely because the calendar year changed.
  const requests = useQuery({ ...orpc.hr.leaveRequests.queryOptions({ input: { branchId: balanceBranchId || undefined, hubId: balanceHubId || undefined } }) });
  const balances = useQuery({ ...orpc.hr.leaveBalances.queryOptions({ input: { year: thisYear, branchId: balanceBranchId || undefined, hubId: balanceHubId || undefined } }) });
  const reviewRequests = useQuery({ ...orpc.hr.leaveRequests.queryOptions({ input: { employeeId: reviewEmployeeId ?? undefined, year: thisYear } }), enabled: Boolean(reviewEmployeeId) });
  const reviewBalances = useQuery({ ...orpc.hr.leaveBalances.queryOptions({ input: { employeeId: reviewEmployeeId ?? undefined, year: thisYear } }), enabled: Boolean(reviewEmployeeId) });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.hr.leaveRequests.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.leaveBalances.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.hr.leaveTypes.key() });
  };
  const create = useMutation({ ...orpc.hr.createLeaveRequest.mutationOptions(), onSuccess: () => { setNote("Leave request was recorded and is awaiting a decision."); setReason(""); refresh(); } });
  const decide = useMutation({ ...orpc.hr.decideLeaveRequest.mutationOptions(), onSuccess: (row) => { setNote(`Leave request ${row.status}.`); refresh(); } });
  const saveType = useMutation({ ...orpc.hr.saveLeaveType.mutationOptions(), onSuccess: () => { setNote("Leave policy was updated."); refresh(); } });
  const adjust = useMutation({ ...orpc.hr.adjustLeaveBalance.mutationOptions(), onSuccess: () => { setNote("Opening/carry-over balance adjustment was added to the audit trail."); setAdjustHalfDays(""); setAdjustReason(""); refresh(); } });

  const error = employees.error ?? branches.error ?? types.error ?? requests.error ?? balances.error ?? create.error ?? decide.error ?? saveType.error ?? adjust.error;
  const activeEmployees = (employees.data ?? []).filter((employee) => employee.status === "active");
  const activeTypes = (types.data ?? []).filter((type) => type.active);
  const hubs = (branches.data ?? []).filter((branch) => branch.type === "hub");
  const filteredBranches = (branches.data ?? []).filter((branch) => branch.type === "branch" && (!balanceHubId || branch.parentHubId === balanceHubId));
  const branchName = new Map((branches.data ?? []).map((branch) => [branch.id, `${branch.code} · ${branch.name}`]));

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
        <div className="mb-3 grid gap-3 md:grid-cols-2"><Field label="Hub"><select className={HR_CONTROL_CLASS} value={balanceHubId} onChange={(e) => { setBalanceHubId(e.target.value); setBalanceBranchId(""); }}><option value="">All hubs</option>{hubs.map((hub) => <option key={hub.id} value={hub.id}>{hub.code} · {hub.name}</option>)}</select></Field><Field label="Branch"><select className={HR_CONTROL_CLASS} value={balanceBranchId} onChange={(e) => setBalanceBranchId(e.target.value)}><option value="">All branches</option>{filteredBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.code} · {branch.name}</option>)}</select></Field></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Employee</th><th className="p-2">Hub / branch</th><th className="p-2">Leave type</th><th className="p-2">Entitled</th><th className="p-2">Adjustment</th><th className="p-2">Used</th><th className="p-2">Available</th></tr></thead><tbody>{(balances.data ?? []).filter((row) => row.paid).map((row) => <tr key={`${row.employeeId}-${row.leaveTypeId}`} className="border-b border-border/60"><td className="p-2"><span className="font-mono">{row.employeeCode}</span><span className="block">{activeEmployees.find((employee) => employee.id === row.employeeId)?.fullName ?? "—"}</span></td><td className="p-2 text-[12px]">{branchName.get(activeEmployees.find((employee) => employee.id === row.employeeId)?.branchId ?? "") ?? "—"}</td><td className="p-2">{row.leaveType}</td><td className="p-2">{row.entitlementHalfDays / 2} d</td><td className="p-2">{row.adjustmentHalfDays / 2} d</td><td className="p-2">{row.usedHalfDays / 2} d</td><td className="p-2 font-semibold">{row.availableHalfDays / 2} d</td></tr>)}</tbody></table>{!balances.isPending && (balances.data ?? []).filter((row) => row.paid).length === 0 ? <p className="py-6 text-center text-[13px] text-muted-foreground">No paid leave balances to display.</p> : null}</div>
      </Card>

      <Card title="Leave requests" description="Pending requests do not consume paid balance until approved. Review and View show employee history before deciding.">
        <Field label="Decision note" hint="Required by the API for approval or rejection."><Input maxLength={500} value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} placeholder="Decision reason" /></Field>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[1050px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Employee</th><th className="p-2">Hub / branch</th><th className="p-2">Category</th><th className="p-2">Dates</th><th className="p-2">Duration</th><th className="p-2">Reason</th><th className="p-2">Status</th><th className="sticky right-0 bg-background p-2 shadow-[-8px_0_12px_-12px_rgba(0,0,0,0.35)]">Actions</th></tr></thead><tbody>{(requests.data ?? []).map(({ request, employeeCode, employeeName, branchId, leaveTypeName, paid }) => <tr key={request.id} className="border-b border-border/60"><td className="p-2"><span className="font-mono">{employeeCode}</span><span className="block">{employeeName}</span></td><td className="p-2 text-[12px]">{branchName.get(branchId) ?? branchId}</td><td className="p-2">{leaveTypeName}<span className="block text-[11px] text-muted-foreground">{paid ? "paid" : "unpaid"}</span></td><td className="p-2 font-mono">{request.startsOn} – {request.endsOn}</td><td className="p-2">{request.halfDays / 2} d</td><td className="p-2">{request.reason}</td><td className="p-2"><Badge variant={request.status === "approved" ? "good" : request.status === "pending" ? "warn" : "outline"}>{request.status}</Badge></td><td className="sticky right-0 bg-background p-2 shadow-[-8px_0_12px_-12px_rgba(0,0,0,0.35)]"><div className="flex flex-wrap gap-1">{request.status === "pending" ? <><Button size="sm" disabled={!decisionNote.trim()} pending={decide.isPending} onClick={() => decide.mutate({ requestId: request.id, decision: "approved", note: decisionNote })}>Approve</Button><Button size="sm" variant="outline" disabled={!decisionNote.trim()} pending={decide.isPending} onClick={() => decide.mutate({ requestId: request.id, decision: "rejected", note: decisionNote })}>Reject</Button></> : null}<Button size="sm" variant="ghost" onClick={() => setReviewEmployeeId(request.employeeId)}>Review</Button><Button size="sm" variant="ghost" onClick={() => setReviewEmployeeId(request.employeeId)}>View</Button></div>{request.status !== "pending" ? <span className="mt-1 block text-[11px] text-muted-foreground">{request.decisionNote ?? "—"}</span> : null}</td></tr>)}</tbody></table>{!requests.isPending && (requests.data ?? []).length === 0 ? <p className="py-6 text-center text-[13px] text-muted-foreground">No leave requests match the selected location.</p> : null}</div>
      </Card>
      <Dialog open={Boolean(reviewEmployeeId)} onOpenChange={(open) => { if (!open) setReviewEmployeeId(null); }} title="Leave review" description="Recent requests, leave history, and current balances for this employee." className="w-[720px]">
        {reviewEmployeeId ? <div className="space-y-4"><div className="rounded-lg border bg-muted/20 p-3 text-[13px]"><strong>{activeEmployees.find((employee) => employee.id === reviewEmployeeId)?.fullName ?? "Employee"}</strong><span className="ml-2 font-mono text-muted-foreground">{activeEmployees.find((employee) => employee.id === reviewEmployeeId)?.employeeCode ?? ""}</span></div><div><h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Balance counts</h3><div className="grid gap-2 sm:grid-cols-2">{(reviewBalances.data ?? []).filter((row) => row.paid).map((row) => <div key={row.leaveTypeId} className="flex justify-between rounded border p-2 text-[12px]"><span>{row.leaveType}</span><span className="font-mono">{row.availableHalfDays / 2} d available</span></div>)}</div></div><div><h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Recent leave history</h3><div className="space-y-2">{(reviewRequests.data ?? []).slice(0, 8).map(({ request, leaveTypeName, paid }) => <div key={request.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-[12px]"><span>{leaveTypeName} · {request.startsOn} – {request.endsOn}<span className="ml-2 text-muted-foreground">{paid ? "paid" : "unpaid"}</span></span><Badge variant={request.status === "approved" ? "good" : request.status === "pending" ? "warn" : "outline"}>{request.status}</Badge></div>)}</div></div></div> : null}
      </Dialog>
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
