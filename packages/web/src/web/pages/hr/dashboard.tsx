import * as React from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck2, ClipboardList, CircleDollarSign, Users } from "lucide-react";
import { orpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, ErrorNote, Page } from "@/components/natex/page";
import { CategoryBars, DailyBars } from "@/components/natex/charts";
import { centsToLkr, todayInColombo } from "./shared";
import { HrNavigation } from "./navigation";

const DAY = 86_400_000;
type AttendancePoint = { date: string; present: number; absent: number; leave: number; offDuty: number };

function daysBefore(day: string, count: number): string[] {
  const end = new Date(`${day}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const current = new Date(end.getTime() - (count - 1 - index) * DAY);
    return current.toISOString().slice(0, 10);
  });
}

function StatCard({ label, value, detail, icon: Icon, tone = "text-brand" }: {
  label: string; value: string; detail: string; icon: React.ElementType; tone?: string;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-[12px] font-medium text-muted-foreground">{label}</p><p className="mt-2 font-mono text-[27px] font-semibold tracking-tight">{value}</p><p className="mt-1 text-[11px] text-muted-foreground">{detail}</p></div>
        <span className={`rounded-md bg-brand/10 p-2 ${tone}`}><Icon className="size-4" aria-hidden /></span>
      </div>
    </Card>
  );
}

export default function HrDashboard() {
  const today = todayInColombo();
  const week = React.useMemo(() => daysBefore(today, 7), [today]);
  const employees = useQuery({ ...orpc.hr.employees.queryOptions({ input: { limit: 5000 } }) });
  const attendance = useQuery({ ...orpc.hr.timesheets.queryOptions({ input: { from: week[0]!, to: today } }) });
  const leave = useQuery({ ...orpc.hr.leaveRequests.queryOptions({ input: { year: Number(today.slice(0, 4)) } }) });
  const runs = useQuery({ ...orpc.hr.payrollRuns.queryOptions() });
  const allEmployees = employees.data ?? [];
  const activeEmployees = allEmployees.filter((employee) => employee.status === "active");
  const pendingLeave = (leave.data ?? []).filter((item) => item.request.status === "pending").length;
  const openRuns = (runs.data ?? []).filter((run) => ["draft", "submitted"].includes(run.status));
  const waitingToday = (attendance.data ?? []).filter((row) => row.workDate === today);
  const presentToday = waitingToday.filter((row) => row.attendanceStatus === "present").length;
  const attendanceByDate: AttendancePoint[] = week.map((date) => {
    const rows = (attendance.data ?? []).filter((row) => row.workDate === date);
    return {
      date,
      present: rows.filter((row) => row.attendanceStatus === "present").length,
      absent: rows.filter((row) => row.attendanceStatus === "absent").length,
      leave: rows.filter((row) => row.attendanceStatus === "leave").length,
      offDuty: rows.filter((row) => row.attendanceStatus === "off_duty").length,
    };
  });
  const departments = [...allEmployees.reduce((counts, employee) => {
    if (employee.status === "active") counts.set(employee.department, (counts.get(employee.department) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()).entries()]
    .map(([label, employeesCount]) => ({ label, employees: employeesCount }))
    .sort((a, b) => b.employees - a.employees)
    .slice(0, 8);
  const latestRun = (runs.data ?? []).find((run) => run.status !== "cancelled");
  const loadError = employees.error ?? attendance.error ?? leave.error ?? runs.error;

  return (
    <Page title="HR & Payroll" description={`Workforce overview · ${today} · Employee and payroll data is visible only to authorized HR/Admin staff.`} actions={<Button asChild><Link href="/hr/attendance"><CalendarCheck2 aria-hidden /> Take attendance</Link></Button>}>
      <HrNavigation />
      {loadError ? <ErrorNote>Some dashboard figures could not be loaded. Refresh the page or check the corresponding HR section.</ErrorNote> : null}
      <section aria-label="HR summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active employees" value={employees.isPending ? "—" : activeEmployees.length.toLocaleString("en-LK")} detail={`${allEmployees.length - activeEmployees.length} inactive in the register`} icon={Users} />
        <StatCard label="Recorded present today" value={attendance.isPending ? "—" : `${presentToday} / ${activeEmployees.length}`} detail={`${waitingToday.length} attendance records saved for today`} icon={CalendarCheck2} tone="text-status-good" />
        <StatCard label="Pending leave requests" value={leave.isPending ? "—" : pendingLeave.toLocaleString("en-LK")} detail="Awaiting HR decision" icon={ClipboardList} tone="text-status-warn" />
        <StatCard label="Open salary runs" value={runs.isPending ? "—" : openRuns.length.toLocaleString("en-LK")} detail={latestRun ? `${latestRun.code} · ${latestRun.status} · net LKR ${centsToLkr(latestRun.netCents)}` : "No payroll run recorded"} icon={CircleDollarSign} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card title="Attendance · last 7 days" description="Counts only saved daily status records; blank dates are not assumed to mean absence.">
          <DailyBars
            data={attendanceByDate}
            title="Recorded attendance statuses over the last seven days"
            stacked
            series={[
              { key: "present", label: "Present", colour: "#10B981" },
              { key: "absent", label: "Absent", colour: "#F43F5E" },
              { key: "leave", label: "Leave", colour: "#64748B" },
              { key: "offDuty", label: "Off duty", colour: "#0EA5E9" },
            ]}
          />
        </Card>
        <Card title="Active employees by department" description="Current active headcount, based on HR employee records.">
          {departments.length ? <CategoryBars data={departments} title="Active employee count by department" series={[{ key: "employees", label: "Employees", colour: "#176B4D" }]} /> : <p className="py-8 text-center text-[13px] text-muted-foreground">Employee counts will appear after HR adds records.</p>}
        </Card>
      </section>

      <Card title="Go to work" description="HR tasks open in the tabs above; salary approval remains a Finance/Admin control.">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link href="/hr/employees">Employee records</Link></Button>
          <Button variant="outline" asChild><Link href="/hr/payroll">Salary operations{openRuns.length ? ` · ${openRuns.length} open` : ""}</Link></Button>
          <Button variant="outline" asChild><Link href="/hr/packages">Create salary package</Link></Button>
          <Button variant="outline" asChild><Link href="/hr/leave">Leave management{pendingLeave ? ` · ${pendingLeave} pending` : ""}</Link></Button>
          {latestRun ? <span className="self-center text-[12px] text-muted-foreground">Latest run: {latestRun.periodStart.slice(0, 7)} · {latestRun.status}</span> : null}
        </div>
      </Card>
    </Page>
  );
}
