import * as React from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck2, CalendarDays, ClipboardCheck, ClipboardList, CircleDollarSign, Filter, Users } from "lucide-react";
import { orpc } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, Page } from "@/components/natex/page";
import { CategoryBars, DailyBars } from "@/components/natex/charts";
import { centsToLkr, currentMonthRange, todayInColombo } from "./shared";
import { HrNavigation } from "./navigation";

const DAY = 86_400_000;
type AttendancePoint = { date: string; present: number; absent: number; leave: number; offDuty: number };

type MetricCardProps = {
  label: string;
  value: string;
  detail: string;
  meta?: string;
  icon: React.ElementType;
  tone?: string;
  href?: string;
};

function daysBefore(day: string, count: number): string[] {
  const end = new Date(`${day}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const current = new Date(end.getTime() - (count - 1 - index) * DAY);
    return current.toISOString().slice(0, 10);
  });
}

function MetricCard({ label, value, detail, meta, icon: Icon, tone = "text-brand", href }: MetricCardProps) {
  return (
    <Card className="border-2 border-brand/20 shadow-sm transition-colors hover:border-brand/40">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
          <p className="mt-2 font-mono text-[27px] font-semibold tracking-tight">{value}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>
          {meta ? <p className="mt-2 text-[11px] font-medium text-foreground/70">{meta}</p> : null}
          {href ? <Link href={href} className="mt-2 inline-block text-[11px] font-semibold text-brand underline-offset-2 hover:underline">Open details →</Link> : null}
        </div>
        <span className={`rounded-lg border border-current/20 bg-brand/10 p-2.5 ${tone}`}><Icon className="size-4" aria-hidden /></span>
      </div>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <Badge variant={status === "approved" || status === "ready" || status === "present" ? "good" : status === "pending" || status === "attention" ? "warn" : "outline"}>{status}</Badge>;
}

export default function HrDashboard() {
  const today = todayInColombo();
  const year = Number(today.slice(0, 4));
  const [range, setRange] = React.useState("7");
  const [customFrom, setCustomFrom] = React.useState(daysBefore(today, 7)[0]!);
  const [customTo, setCustomTo] = React.useState(today);
  const [hubId, setHubId] = React.useState("");
  const [branchId, setBranchId] = React.useState("");
  const [department, setDepartment] = React.useState("");
  const rangeDays = range === "30" ? 30 : range === "custom" ? 0 : 7;
  const fromDate = range === "custom" ? customFrom : daysBefore(today, rangeDays)[0]!;
  const toDate = range === "custom" ? customTo : today;
  const approvalRange = currentMonthRange();

  const employees = useQuery({ ...orpc.hr.employees.queryOptions({ input: { limit: 5000 } }) });
  const branches = useQuery({ ...orpc.identity.listBranches.queryOptions({ input: { includeInactive: true } }) });
  const attendance = useQuery({ ...orpc.hr.timesheets.queryOptions({ input: { from: fromDate, to: toDate } }) });
  const leave = useQuery({ ...orpc.hr.leaveRequests.queryOptions({ input: { year, hubId: hubId || undefined, branchId: branchId || undefined } }) });
  const balances = useQuery({ ...orpc.hr.leaveBalances.queryOptions({ input: { year, hubId: hubId || undefined, branchId: branchId || undefined } }) });
  const runs = useQuery({ ...orpc.hr.payrollRuns.queryOptions() });
  const pendingAttendance = useQuery({ ...orpc.hr.attendanceRows.queryOptions({ input: { ...approvalRange, approvalStatus: "pending" } }) });
  const holidays = useQuery({ ...orpc.hr.holidays.queryOptions({ input: { year } }) });
  const payoutRuns = useQuery({ ...orpc.hr.leavePayoutRuns.queryOptions() });

  const allEmployees = employees.data ?? [];
  const activeEmployees = allEmployees.filter((employee) => employee.status === "active");
  const allBranches = branches.data ?? [];
  const hubs = allBranches.filter((branch) => branch.type === "hub");
  const visibleBranches = allBranches.filter((branch) => branch.type === "branch" && (!hubId || branch.parentHubId === hubId));
  const branchMap = new Map(allBranches.map((branch) => [branch.id, `${branch.code} · ${branch.name}`]));
  const employeeMatches = activeEmployees.filter((employee) => (!hubId || allBranches.find((branch) => branch.id === employee.branchId)?.parentHubId === hubId) && (!branchId || employee.branchId === branchId) && (!department || employee.department === department));
  const employeeIds = new Set(employeeMatches.map((employee) => employee.id));
  const attendanceRows = (attendance.data ?? []).filter((row) => employeeIds.has(row.employeeId));
  const leaveRows = (leave.data ?? []).filter((item) => employeeIds.has(item.request.employeeId));
  const pendingLeave = leaveRows.filter((item) => item.request.status === "pending").length;
  const approvedLeave = leaveRows.filter((item) => item.request.status === "approved").length;
  const latestRun = (runs.data ?? []).find((run) => run.status !== "cancelled");
  const openRuns = (runs.data ?? []).filter((run) => ["draft", "submitted"].includes(run.status));
  const submittedRuns = (runs.data ?? []).filter((run) => run.status === "submitted");
  const recordsAtEnd = attendanceRows.filter((row) => row.workDate === toDate);
  const presentAtEnd = recordsAtEnd.filter((row) => row.attendanceStatus === "present").length;
  const attendanceCoverage = employeeMatches.length ? Math.round((recordsAtEnd.length / employeeMatches.length) * 100) : 0;
  const nextHoliday = (holidays.data ?? []).find((holiday) => holiday.holidayDate >= today);
  const latestPayout = [...(payoutRuns.data ?? [])].sort((a, b) => b.year - a.year)[0];
  const paidBalances = (balances.data ?? []).filter((row) => row.paid && employeeIds.has(row.employeeId));
  const lowBalanceCount = paidBalances.filter((row) => row.availableHalfDays <= 2).length;
  const departments = [...new Set(activeEmployees.map((employee) => employee.department))].sort();
  const attendanceByDate: AttendancePoint[] = daysBefore(toDate, range === "30" ? 30 : range === "custom" ? Math.max(1, Math.min(30, Math.round((new Date(`${toDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) / DAY) + 1)) : 7).map((date) => {
    const rows = attendanceRows.filter((row) => row.workDate === date);
    return { date, present: rows.filter((row) => row.attendanceStatus === "present").length, absent: rows.filter((row) => row.attendanceStatus === "absent").length, leave: rows.filter((row) => row.attendanceStatus === "leave").length, offDuty: rows.filter((row) => row.attendanceStatus === "off_duty").length };
  });
  const branchRows = [...new Set(employeeMatches.map((employee) => employee.branchId))].map((currentBranchId) => {
    const staff = employeeMatches.filter((employee) => employee.branchId === currentBranchId);
    const staffIds = new Set(staff.map((employee) => employee.id));
    const records = attendanceRows.filter((row) => staffIds.has(row.employeeId) && row.workDate === toDate);
    const branchLeave = leaveRows.filter((item) => staffIds.has(item.request.employeeId) && item.request.status === "pending");
    const coverage = staff.length ? Math.round((records.length / staff.length) * 100) : 0;
    return { id: currentBranchId, name: branchMap.get(currentBranchId) ?? currentBranchId, staff: staff.length, coverage, pendingLeave: branchLeave.length, status: coverage >= 90 && branchLeave.length < 3 ? "ready" : "attention" };
  }).sort((a, b) => a.coverage - b.coverage);
  const missingAttendance = employeeMatches.filter((employee) => !recordsAtEnd.some((row) => row.employeeId === employee.id));
  const exceptions = [...missingAttendance.slice(0, 5).map((employee) => ({ label: `${employee.employeeCode} · ${employee.fullName}`, detail: "Attendance not submitted", href: "/hr/attendance" })), ...paidBalances.filter((row) => row.availableHalfDays <= 2).slice(0, 5).map((row) => ({ label: row.employeeCode, detail: `${row.leaveType} balance is ${row.availableHalfDays / 2} days`, href: "/hr/leave" }))];
  const loadError = employees.error ?? branches.error ?? attendance.error ?? pendingAttendance.error ?? leave.error ?? balances.error ?? runs.error ?? holidays.error ?? payoutRuns.error;

  return (
    <Page title="HR & Payroll" description={`Workforce decision dashboard · ${today} · Filters apply to the operational summaries below.`} actions={<div className="flex gap-2"><Button variant="outline" asChild><Link href="/hr/calendar"><CalendarDays aria-hidden /> Year calendar</Link></Button><Button asChild><Link href="/hr/attendance"><CalendarCheck2 aria-hidden /> Take attendance</Link></Button></div>}>
      <HrNavigation />
      {loadError ? <ErrorNote>Some dashboard figures could not be loaded. Open the corresponding HR section for details.</ErrorNote> : null}

      <Card title="Dashboard filters" description="Use one location and department scope to review the same workforce slice across attendance, leave, payroll readiness, and exceptions.">
        <div className="grid gap-3 md:grid-cols-5"><Field label="Period"><select className="h-9 rounded-md border border-input bg-background px-3 text-[13px]" value={range} onChange={(event) => setRange(event.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="custom">Custom range</option></select></Field><Field label="Hub"><select className="h-9 rounded-md border border-input bg-background px-3 text-[13px]" value={hubId} onChange={(event) => { setHubId(event.target.value); setBranchId(""); }}><option value="">All hubs</option>{hubs.map((hub) => <option key={hub.id} value={hub.id}>{hub.code} · {hub.name}</option>)}</select></Field><Field label="Branch"><select className="h-9 rounded-md border border-input bg-background px-3 text-[13px]" value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">All branches</option>{visibleBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.code} · {branch.name}</option>)}</select></Field><Field label="Department"><select className="h-9 rounded-md border border-input bg-background px-3 text-[13px]" value={department} onChange={(event) => setDepartment(event.target.value)}><option value="">All departments</option>{departments.map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>{range === "custom" ? <div className="grid grid-cols-2 gap-2"><Field label="From"><Input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></Field><Field label="To"><Input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></Field></div> : <div className="flex items-end"><span className="flex h-9 items-center gap-2 text-[12px] text-muted-foreground"><Filter className="size-3.5" /> {fromDate} → {toDate}</span></div>}</div>
      </Card>

      <section aria-label="Approval queue" className="grid gap-4 lg:grid-cols-3"><ApprovalCard label="Pending leave" value={leave.isPending ? "—" : pendingLeave.toLocaleString("en-LK")} detail="Requests awaiting HR decision" href="/hr/approvals" tone="text-status-warn" /><ApprovalCard label="Pending attendance" value={pendingAttendance.isPending ? "—" : (pendingAttendance.data?.length ?? 0).toLocaleString("en-LK")} detail="Attendance entries awaiting review" href="/hr/approvals" tone="text-status-warn" /><ApprovalCard label="Submitted payroll" value={runs.isPending ? "—" : submittedRuns.length.toLocaleString("en-LK")} detail="Payroll runs ready for approval" href="/hr/payroll" tone="text-brand" /></section>

      <Card title="Quick links" description="Open the HR desk for the next workforce task."><div className="flex flex-wrap gap-2"><Button variant="outline" asChild><Link href="/hr/employees">Employees</Link></Button><Button variant="outline" asChild><Link href="/hr/leave">Leave</Link></Button><Button variant="outline" asChild><Link href="/hr/attendance">Attendance</Link></Button><Button variant="outline" asChild><Link href="/hr/payroll">Salary operations</Link></Button><Button variant="outline" asChild><Link href="/hr/approvals">Approvals</Link></Button></div></Card>

      <section aria-label="HR summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard label="Active staff" value={employees.isPending ? "—" : employeeMatches.length.toLocaleString("en-LK")} detail={`${allEmployees.length - activeEmployees.length} inactive in register`} meta={`${new Set(employeeMatches.map((employee) => employee.branchId)).size} branches`} icon={Users} href="/hr/employees" />
        <MetricCard label="Attendance" value={attendance.isPending ? "—" : `${presentAtEnd} / ${employeeMatches.length}`} detail={`${recordsAtEnd.length} records on ${toDate}`} meta={`${attendanceCoverage}% coverage`} icon={CalendarCheck2} tone="text-status-good" href="/hr/attendance" />
        <MetricCard label="Leave queue" value={leave.isPending ? "—" : pendingLeave.toLocaleString("en-LK")} detail="Requests awaiting decision" meta={`${approvedLeave} approved this year`} icon={ClipboardList} tone="text-status-warn" href="/hr/leave" />
        <MetricCard label="Payroll readiness" value={openRuns.length ? "Attention" : "Ready"} detail={latestRun ? `${latestRun.code} · ${latestRun.status}` : "No payroll run recorded"} meta={latestRun ? `Net LKR ${centsToLkr(latestRun.netCents)}` : "Create a run after review"} icon={CircleDollarSign} href="/hr/payroll" />
        <MetricCard label="Next holiday" value={nextHoliday?.holidayDate ?? "—"} detail={nextHoliday?.name ?? "No holiday configured"} meta={nextHoliday ? `${nextHoliday.otAllowed ? "OT enabled" : "OT disabled"}${nextHoliday.compulsoryLeave ? " · unpaid compulsory" : ""}` : "Add to year calendar"} icon={CalendarDays} href="/hr/calendar" />
        <MetricCard label="Leave risk" value={lowBalanceCount.toLocaleString("en-LK")} detail="Paid-leave balances ≤ 1 day" meta={latestPayout ? `Payout ${latestPayout.status}` : "Year-end payout not generated"} icon={ClipboardList} tone="text-status-warn" href="/hr/leave" />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]"><Card title="Action required" description="Prioritized items for the selected workforce scope."><div className="space-y-2"><ActionRow priority={pendingLeave ? "High" : "Clear"} label={`${pendingLeave} leave requests awaiting approval`} href="/hr/leave" /><ActionRow priority={missingAttendance.length ? "High" : "Clear"} label={`${missingAttendance.length} staff without attendance for ${toDate}`} href="/hr/attendance" /><ActionRow priority={lowBalanceCount ? "Medium" : "Clear"} label={`${lowBalanceCount} staff with one day or less paid leave`} href="/hr/leave" /><ActionRow priority={nextHoliday && !nextHoliday.otAllowed ? "Medium" : "Clear"} label={nextHoliday ? `${nextHoliday.name} has OT ${nextHoliday.otAllowed ? "enabled" : "disabled"}` : "No upcoming holiday configured"} href="/hr/calendar" /><ActionRow priority={openRuns.length ? "Medium" : "Clear"} label={openRuns.length ? `${openRuns.length} payroll run(s) need attention` : "No open payroll run"} href="/hr/payroll" /></div></Card><Card title="Payroll readiness" description="Checks that should be resolved before payroll approval."><div className="grid gap-2 text-[13px]"><ReadinessRow label="Attendance submitted" value={`${attendanceCoverage}%`} good={attendanceCoverage >= 90} /><ReadinessRow label="Leave approvals" value={`${pendingLeave} pending`} good={!pendingLeave} /><ReadinessRow label="Open payroll runs" value={`${openRuns.length}`} good={!openRuns.length} /><ReadinessRow label="Low leave balances" value={`${lowBalanceCount}`} good={!lowBalanceCount} /><div className="mt-2 rounded-md border border-brand/20 bg-brand/5 p-3 text-[12px] text-muted-foreground">Payroll should be submitted only after attendance and leave exceptions are reviewed for the selected branch scope.</div></div></Card></section>

      <section className="grid gap-4 xl:grid-cols-[1.4fr_1fr]"><Card title={`Attendance · ${fromDate} to ${toDate}`} description="Blank records remain different from absence. Use the attendance page to complete missing submissions."><DailyBars data={attendanceByDate} title="Attendance status trend" stacked series={[{ key: "present", label: "Present", colour: "#10B981" }, { key: "absent", label: "Absent", colour: "#F43F5E" }, { key: "leave", label: "Leave", colour: "#64748B" }, { key: "offDuty", label: "Off duty", colour: "#0EA5E9" }]} /></Card><Card title="Upcoming holidays" description="Holiday work rules are visible here before payroll is calculated."><div className="space-y-3">{(holidays.data ?? []).filter((holiday) => holiday.holidayDate >= today).slice(0, 5).map((holiday) => <div key={holiday.id} className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2"><div><p className="font-medium">{holiday.name}</p><p className="font-mono text-[12px] text-muted-foreground">{holiday.holidayDate} · {holiday.scope}</p></div><div className="flex flex-wrap justify-end gap-1"><StatusBadge status={holiday.otAllowed ? "OT enabled" : "OT disabled"} />{holiday.compulsoryLeave ? <Badge variant="warn">Unpaid compulsory</Badge> : null}</div></div>)}{!(holidays.data ?? []).filter((holiday) => holiday.holidayDate >= today).length ? <p className="py-5 text-center text-[13px] text-muted-foreground">No upcoming holidays. <Link className="text-brand underline" href="/hr/calendar">Add one in the calendar.</Link></p> : null}<Button variant="outline" asChild><Link href="/hr/calendar">Open year calendar</Link></Button></div></Card></section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]"><Card title="Leave details" description="Recent leave records for the selected hub, branch, and department."><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Employee</th><th className="p-2">Branch</th><th className="p-2">Type</th><th className="p-2">Dates</th><th className="p-2">Status</th></tr></thead><tbody>{leaveRows.slice(0, 8).map(({ request, employeeCode, employeeName, branchId: requestBranchId, leaveTypeName }) => <tr key={request.id} className="border-b border-border/60"><td className="p-2"><span className="font-mono">{employeeCode}</span><span className="block">{employeeName}</span></td><td className="p-2 text-[12px]">{branchMap.get(requestBranchId) ?? requestBranchId}</td><td className="p-2">{leaveTypeName}</td><td className="p-2 font-mono">{request.startsOn} – {request.endsOn}</td><td className="p-2"><StatusBadge status={request.status} /></td></tr>)}</tbody></table>{!leaveRows.length ? <p className="py-6 text-center text-[13px] text-muted-foreground">No leave details match this scope.</p> : null}</div><Button className="mt-3" variant="outline" asChild><Link href="/hr/leave">Open leave desk</Link></Button></Card><Card title="Staff exceptions" description="Operational risks requiring review."><div className="space-y-2">{exceptions.map((item, index) => <Link key={`${item.label}-${index}`} href={item.href} className="block rounded-md border border-status-warn/30 bg-status-warn/5 px-3 py-2 hover:border-status-warn"><p className="text-[13px] font-medium">{item.label}</p><p className="text-[11px] text-muted-foreground">{item.detail}</p></Link>)}{!exceptions.length ? <p className="py-5 text-center text-[13px] text-muted-foreground">No staff exceptions in this scope.</p> : null}</div></Card></section>

      <Card title="Hub and branch comparison" description="Attendance coverage and pending leave make it clear where HR attention is needed first."><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Branch</th><th className="p-2">Active staff</th><th className="p-2">Attendance</th><th className="p-2">Pending leave</th><th className="p-2">Status</th></tr></thead><tbody>{branchRows.map((row) => <tr key={row.id} className="border-b border-border/60"><td className="p-2 font-medium">{row.name}</td><td className="p-2">{row.staff}</td><td className="p-2">{row.coverage}%</td><td className="p-2">{row.pendingLeave}</td><td className="p-2"><StatusBadge status={row.status} /></td></tr>)}</tbody></table>{!branchRows.length ? <p className="py-6 text-center text-[13px] text-muted-foreground">No branches match the selected filters.</p> : null}</div></Card>

      <Card title="Department overview" description="Active headcount within the current HR workforce register."><CategoryBars data={[...activeEmployees.reduce((counts, employee) => { if (!department || employee.department === department) counts.set(employee.department, (counts.get(employee.department) ?? 0) + 1); return counts; }, new Map<string, number>()).entries()].map(([label, employeesCount]) => ({ label, employees: employeesCount }))} title="Active staff by department" series={[{ key: "employees", label: "Employees", colour: "#176B4D" }]} /></Card>

      <Card title="Go to work" description="Use the detailed HR desks for edits and approvals."><div className="flex flex-wrap gap-2"><Button variant="outline" asChild><Link href="/hr/employees">Employee records</Link></Button><Button variant="outline" asChild><Link href="/hr/leave">Leave management</Link></Button><Button variant="outline" asChild><Link href="/hr/calendar">Year calendar & payout</Link></Button><Button variant="outline" asChild><Link href="/hr/timesheets">Timesheets</Link></Button></div></Card>
    </Page>
  );
}

function ActionRow({ priority, label, href }: { priority: string; label: string; href: string }) {
  return <Link href={href} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 hover:border-brand/50"><span className="text-[13px]">{label}</span><StatusBadge status={priority} /></Link>;
}

function ApprovalCard({ label, value, detail, href, tone }: { label: string; value: string; detail: string; href: string; tone: string }) {
  return <Card className="border-2 border-brand/20 shadow-sm"><div className="flex items-start justify-between gap-3"><div><p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</p><p className={`mt-2 font-mono text-[30px] font-semibold tracking-tight ${tone}`}>{value}</p><p className="mt-1 text-[12px] text-muted-foreground">{detail}</p><Link href={href} className="mt-3 inline-block text-[12px] font-semibold text-brand underline-offset-2 hover:underline">Review queue →</Link></div><ClipboardCheck className={`size-5 ${tone}`} aria-hidden /></div></Card>;
}

function ReadinessRow({ label, value, good }: { label: string; value: string; good: boolean }) {
  return <div className="flex items-center justify-between border-b border-border/60 py-2"><span>{label}</span><Badge variant={good ? "good" : "warn"}>{value}</Badge></div>;
}
