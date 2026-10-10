import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, KeyValue, KeyValueGrid, SuccessNote } from "@/components/natex/page";
import { centsToLkr, currentMonthRange, HR_CONTROL_CLASS, todayInColombo } from "./shared";
import { EmployeeDocuments } from "./employee-documents";

type Employee = {
  id: string; employeeCode: string; fullName: string; nationalId: string | null; phone: string | null;
  email: string | null; address: string | null; branchId: string; department: string; jobTitle: string;
  employmentType: string; joinedOn: string; endedOn: string | null; status: string; epfNumber: string | null;
  tin: string | null; primaryEmployment: boolean; overtimePolicy: string;
};
type Package = { id: string; code: string; name: string; payBasis: string; basePayCents: number; active: boolean };
type Section = "profile" | "documents" | "attendance" | "leave" | "salary";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "profile", label: "Details" },
  { id: "documents", label: "Documents" },
  { id: "attendance", label: "Attendance" },
  { id: "leave", label: "Leave" },
  { id: "salary", label: "Salary" },
];
const hours = (minutes: number) => (minutes / 60).toFixed(2).replace(/\.00$/, "");

export function EmployeeDetails({ employee, branchName, packages, initialSection = "profile", onClose }: {
  employee: Employee; branchName: string; packages: Package[]; initialSection?: Section; onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [section, setSection] = React.useState<Section>(initialSection);
  const [packageId, setPackageId] = React.useState("");
  const [effectiveFrom, setEffectiveFrom] = React.useState(todayInColombo());
  const [month, setMonth] = React.useState(currentMonthRange().from.slice(0, 7));
  const [notice, setNotice] = React.useState<string | null>(null);
  const [from, to] = React.useMemo(() => {
    const [year, monthNumber] = month.split("-").map(Number);
    const last = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
    return [`${month}-01`, `${month}-${String(last).padStart(2, "0")}`];
  }, [month]);
  const assignments = useQuery({ ...orpc.hr.employeePackages.queryOptions({ input: { employeeId: employee.id } }) });
  const attendance = useQuery({ ...orpc.hr.timesheets.queryOptions({ input: { from, to, employeeId: employee.id } }), enabled: section === "attendance" });
  const leave = useQuery({ ...orpc.hr.leaveRequests.queryOptions({ input: { employeeId: employee.id, year: Number(todayInColombo().slice(0, 4)) } }), enabled: section === "leave" });
  const assign = useMutation({
    ...orpc.hr.assignSalaryPackage.mutationOptions(),
    onSuccess: () => {
      setNotice("Salary package was assigned with the selected effective date.");
      setPackageId("");
      void queryClient.invalidateQueries({ queryKey: orpc.hr.employeePackages.key() });
    },
  });

  return (
    <Card title={`${employee.employeeCode} · ${employee.fullName}`} description={`${employee.department} · ${employee.jobTitle}`} actions={<Button size="sm" variant="ghost" onClick={onClose}>Close record</Button>}>
      {notice ? <SuccessNote>{notice}</SuccessNote> : null}
      {assign.error ? <ErrorNote>{apiMessage(assign.error, "The salary package could not be assigned.")}</ErrorNote> : null}
      <div role="tablist" aria-label={`Employee record sections for ${employee.employeeCode}`} className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
        {SECTIONS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={section === item.id} onClick={() => setSection(item.id)} className={`-mb-px border-b-2 px-3 py-2 text-[12px] font-medium ${section === item.id ? "border-brand text-brand" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{item.label}</button>)}
      </div>
      {section === "profile" ? <div role="tabpanel"><KeyValueGrid columns={3}>
        <KeyValue label="Employee code" mono>{employee.employeeCode}</KeyValue>
        <KeyValue label="Status"><Badge variant={employee.status === "active" ? "good" : "outline"}>{employee.status}</Badge></KeyValue>
        <KeyValue label="Branch / hub">{branchName}</KeyValue>
        <KeyValue label="Department">{employee.department}</KeyValue>
        <KeyValue label="Job title">{employee.jobTitle}</KeyValue>
        <KeyValue label="Employment type">{employee.employmentType}</KeyValue>
        <KeyValue label="Joined on">{employee.joinedOn}</KeyValue>
        <KeyValue label="End date">{employee.endedOn ?? "—"}</KeyValue>
        <KeyValue label="Phone">{employee.phone ?? "—"}</KeyValue>
        <KeyValue label="Email">{employee.email ?? "—"}</KeyValue>
        <KeyValue label="Address">{employee.address ?? "—"}</KeyValue>
        <KeyValue label="National ID">{employee.nationalId ?? "—"}</KeyValue>
        <KeyValue label="EPF member number">{employee.epfNumber ?? "—"}</KeyValue>
        <KeyValue label="TIN">{employee.tin ?? "—"}</KeyValue>
        <KeyValue label="APIT employment">{employee.primaryEmployment ? "Primary" : "Secondary"}</KeyValue>
        <KeyValue label="Overtime policy">{employee.overtimePolicy.replaceAll("_", " ")}</KeyValue>
      </KeyValueGrid></div> : null}
      {section === "documents" ? <div role="tabpanel"><EmployeeDocuments employeeId={employee.id} /></div> : null}
      {section === "attendance" ? <div role="tabpanel">
        <div className="mb-3 flex flex-wrap items-end gap-3"><Field label="Attendance month"><Input type="month" value={month} onChange={(event) => setMonth(event.target.value || currentMonthRange().from.slice(0, 7))} /></Field><span className="pb-2 text-[12px] text-muted-foreground">{from} → {to}</span></div>
        {attendance.error ? <ErrorNote>{apiMessage(attendance.error, "Attendance history could not be loaded.")}</ErrorNote> : null}
        <div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Date</th><th className="p-2">Status</th><th className="p-2 text-right">Regular</th><th className="p-2 text-right">Overtime</th><th className="p-2">Note</th></tr></thead><tbody>{(attendance.data ?? []).map((row) => <tr key={row.id} className="border-b border-border/60"><td className="p-2 font-mono">{row.workDate}</td><td className="p-2">{row.attendanceStatus.replaceAll("_", " ")}</td><td className="p-2 text-right font-mono">{hours(row.regularMinutes)} h</td><td className="p-2 text-right font-mono">{hours(row.overtimeMinutes)} h</td><td className="p-2">{row.note ?? "—"}</td></tr>)}</tbody></table>{!attendance.isPending && (attendance.data?.length ?? 0) === 0 ? <p className="py-6 text-center text-[13px] text-muted-foreground">No attendance rows for this month.</p> : null}</div>
      </div> : null}
      {section === "leave" ? <div role="tabpanel">
        {leave.error ? <ErrorNote>{apiMessage(leave.error, "Leave history could not be loaded.")}</ErrorNote> : null}
        <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Leave type</th><th className="p-2">Dates</th><th className="p-2">Days</th><th className="p-2">Status</th><th className="p-2">Reason</th></tr></thead><tbody>{(leave.data ?? []).map(({ request, leaveTypeName }) => <tr key={request.id} className="border-b border-border/60"><td className="p-2">{leaveTypeName}</td><td className="p-2 font-mono">{request.startsOn} → {request.endsOn}</td><td className="p-2">{request.halfDays / 2}</td><td className="p-2"><Badge variant={request.status === "approved" ? "good" : request.status === "pending" ? "warn" : "outline"}>{request.status}</Badge></td><td className="p-2">{request.reason}</td></tr>)}</tbody></table>{!leave.isPending && (leave.data?.length ?? 0) === 0 ? <p className="py-6 text-center text-[13px] text-muted-foreground">No leave requests recorded this year.</p> : null}</div>
        <p className="mt-3 text-[12px] text-muted-foreground">For leave balances, approvals and adjustments, use the Leave tab in the HR workspace.</p>
      </div> : null}
      {section === "salary" ? <div role="tabpanel">
        <form className="grid gap-3 md:grid-cols-[1fr_220px_auto]" onSubmit={(event) => { event.preventDefault(); if (packageId) assign.mutate({ employeeId: employee.id, packageId, effectiveFrom }); }}>
          <Field label="Salary package"><select required className={HR_CONTROL_CLASS} value={packageId} onChange={(event) => setPackageId(event.target.value)}><option value="">Select active package</option>{packages.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name} · LKR {centsToLkr(item.basePayCents)} ({item.payBasis})</option>)}</select></Field>
          <Field label="Effective from"><Input type="date" required value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></Field>
          <div className="self-end"><Button type="submit" pending={assign.isPending} disabled={!packageId || employee.status !== "active"}>Assign package</Button></div>
        </form>
        {assignments.error ? <ErrorNote>{apiMessage(assignments.error, "Salary history could not be loaded.")}</ErrorNote> : null}
        <div className="mt-4 space-y-2 border-t pt-4">{(assignments.data ?? []).map(({ assignment, package: pkg }) => <div key={assignment.id} className="flex flex-wrap justify-between gap-2 rounded border border-border/70 p-3 text-[13px]"><span><strong className="font-mono">{pkg.code}</strong> · {pkg.name} · {pkg.payBasis} · LKR {centsToLkr(pkg.basePayCents)}</span><span className="font-mono text-[11px] text-muted-foreground">{assignment.effectiveFrom} → {assignment.effectiveTo ?? "current"}</span></div>)}</div>
        {!assignments.isPending && (assignments.data?.length ?? 0) === 0 ? <p className="mt-4 text-[12px] text-muted-foreground">No salary package is assigned. Create one in Salary packages, then assign it here.</p> : null}
      </div> : null}
    </Card>
  );
}
