import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { HR_CONTROL_CLASS, todayInColombo } from "./shared";
import { HrNavigation } from "./navigation";

type Status = "not_recorded" | "present" | "absent" | "leave" | "off_duty";
type Draft = { status: Status; regularHours: string; overtimeHours: string; note: string };
const LABEL: Record<Status, string> = { not_recorded: "Not recorded", present: "Present", absent: "Absent", leave: "Leave", off_duty: "Off duty" };
const today = todayInColombo();
const toHours = (minutes: number) => (minutes / 60).toFixed(2).replace(/\.00$/, "");

export default function HrAttendance() {
  const queryClient = useQueryClient();
  const [workDate, setWorkDate] = React.useState(today);
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({});
  const [notice, setNotice] = React.useState<string | null>(null);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const employees = useQuery({ ...orpc.hr.employees.queryOptions({ input: { status: "active", limit: 5000 } }) });
  const rows = useQuery({ ...orpc.hr.timesheets.queryOptions({ input: { from: workDate, to: workDate } }) });
  React.useEffect(() => {
    const saved = new Map((rows.data ?? []).map((row) => [row.employeeId, row]));
    setDrafts(Object.fromEntries((employees.data ?? []).map((employee) => {
      const record = saved.get(employee.id);
      return [employee.id, {
        status: record ? record.attendanceStatus as Status : "not_recorded",
        regularHours: record ? toHours(record.regularMinutes) : "8",
        overtimeHours: record ? toHours(record.overtimeMinutes) : "0",
        note: record?.note ?? "",
      }];
    })));
  }, [employees.data, rows.data, workDate]);

  const save = useMutation({
    ...orpc.hr.saveTimesheets.mutationOptions(),
    onSuccess: (result) => {
      setNotice(`Attendance saved for ${result.imported} employee(s).`);
      setLocalError(null);
      void queryClient.invalidateQueries({ queryKey: orpc.hr.timesheets.key() });
    },
  });
  const activeEmployees = employees.data ?? [];
  const recordedCount = Object.values(drafts).filter((draft) => draft.status !== "not_recorded").length;
  const absentCount = Object.values(drafts).filter((draft) => draft.status === "absent").length;

  function setStatus(employeeId: string, status: Status) {
    setDrafts((current) => {
      const previous = current[employeeId] ?? { status: "not_recorded", regularHours: "8", overtimeHours: "0", note: "" };
      const enteringPresent = status === "present" && previous.status !== "present";
      const nonWorking = ["absent", "leave", "off_duty"].includes(status);
      return { ...current, [employeeId]: {
        ...previous,
        status,
        regularHours: nonWorking ? "0" : enteringPresent ? "8" : previous.regularHours,
        overtimeHours: nonWorking ? "0" : previous.overtimeHours,
      } };
    });
  }

  function markAll(status: "present" | "absent") {
    setDrafts(Object.fromEntries(activeEmployees.map((employee) => [employee.id, {
      status,
      regularHours: status === "present" ? "8" : "0",
      overtimeHours: "0",
      note: drafts[employee.id]?.note ?? "",
    }])));
  }

  function saveAttendance(event: React.FormEvent) {
    event.preventDefault();
    setNotice(null);
    setLocalError(null);
    let validationMessage: string | null = null;
    const payload = activeEmployees.flatMap((employee) => {
      const draft = drafts[employee.id];
      if (!draft || draft.status === "not_recorded") return [];
      const regular = Number(draft.regularHours);
      const overtime = Number(draft.overtimeHours);
      if (![regular, overtime].every((hours) => Number.isFinite(hours) && hours >= 0 && hours <= 24)) {
        validationMessage = `Enter valid regular and overtime hours for ${employee.employeeCode}.`;
        return [];
      }
      if (draft.status !== "present" && (regular !== 0 || overtime !== 0)) {
        validationMessage = `${LABEL[draft.status]} records must have zero work hours for ${employee.employeeCode}.`;
        return [];
      }
      if (draft.status === "present" && regular + overtime > 24) {
        validationMessage = `Regular and overtime hours cannot exceed 24 for ${employee.employeeCode}.`;
        return [];
      }
      return [{
        employeeCode: employee.employeeCode,
        workDate,
        regularMinutes: Math.round(regular * 60),
        overtimeMinutes: Math.round(overtime * 60),
        attendanceStatus: draft.status as Exclude<Status, "not_recorded">,
        note: draft.note,
        source: "manual" as const,
      }];
    });
    if (validationMessage) { setLocalError(validationMessage); return; }
    if (!payload.length) { setLocalError("Mark at least one employee's attendance before saving."); return; }
    if (payload.some((row) => row.regularMinutes + row.overtimeMinutes > 1440)) { setLocalError("Daily work time cannot exceed 24 hours."); return; }
    save.mutate({ rows: payload });
  }

  const error = employees.error ?? rows.error ?? save.error;
  return (
    <Page title="Attendance" description="Record each employee's daily status and hours. Attendance is HR-entered; it is not a biometric clock-in or employee self-service feature.">
      <HrNavigation />
      {notice ? <SuccessNote>{notice}</SuccessNote> : null}
      {localError ? <ErrorNote>{localError}</ErrorNote> : null}
      {error ? <ErrorNote>{apiMessage(error, "Attendance could not be loaded or saved.")}</ErrorNote> : null}
      <Card title="Take attendance" description="Not-recorded employees are left unchanged when saving. Choose Leave here for the daily register and record the formal request/balance separately in Leave management.">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3"><Field label="Attendance date"><Input type="date" required value={workDate} max={today} onChange={(event) => { setWorkDate(event.target.value || today); setNotice(null); setLocalError(null); }} /></Field><span className="pb-2 text-[12px] text-muted-foreground">{recordedCount} of {activeEmployees.length} recorded · {absentCount} absent</span></div>
          <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => markAll("present")} disabled={!activeEmployees.length}>Mark all present · 8h</Button><Button type="button" variant="outline" onClick={() => markAll("absent")} disabled={!activeEmployees.length}>Mark all absent</Button></div>
        </div>
        <form onSubmit={saveAttendance}>
          <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Employee</th><th className="p-2">Department</th><th className="p-2">Status</th><th className="p-2 text-right">Regular hours</th><th className="p-2 text-right">Overtime</th><th className="p-2">Note</th></tr></thead><tbody>
            {activeEmployees.map((employee) => {
              const draft = drafts[employee.id] ?? { status: "not_recorded", regularHours: "8", overtimeHours: "0", note: "" };
              const change = (patch: Partial<Draft>) => setDrafts((current) => ({ ...current, [employee.id]: { ...draft, ...patch } }));
              const disabled = draft.status !== "present";
              return <tr key={employee.id} className="border-b border-border/60"><td className="p-2"><span className="font-mono text-[11px]">{employee.employeeCode}</span><span className="ml-2 font-medium">{employee.fullName}</span></td><td className="p-2">{employee.department}</td><td className="p-2"><select aria-label={`Attendance status for ${employee.employeeCode}`} className={HR_CONTROL_CLASS} value={draft.status} onChange={(event) => setStatus(employee.id, event.target.value as Status)}>{Object.entries(LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td><td className="p-2"><Input aria-label={`Regular hours for ${employee.employeeCode}`} className="w-24 text-right" type="number" min="0" max="24" step="0.25" value={draft.regularHours} disabled={disabled} onChange={(event) => change({ regularHours: event.target.value })} /></td><td className="p-2"><Input aria-label={`Overtime hours for ${employee.employeeCode}`} className="w-24 text-right" type="number" min="0" max="24" step="0.25" value={draft.overtimeHours} disabled={disabled} onChange={(event) => change({ overtimeHours: event.target.value })} /></td><td className="p-2"><Input aria-label={`Attendance note for ${employee.employeeCode}`} maxLength={500} value={draft.note} onChange={(event) => change({ note: event.target.value })} /></td></tr>;
            })}
          </tbody></table>{!employees.isPending && activeEmployees.length === 0 ? <p className="py-8 text-center text-[13px] text-muted-foreground">No active employees are in the register.</p> : null}</div>
          <div className="mt-4 flex flex-wrap items-center gap-3"><Button type="submit" pending={save.isPending} disabled={recordedCount === 0}>Save attendance</Button><p className="text-[11px] text-muted-foreground">Saved hours also appear in Timesheets and feed the payroll calculation basis. Approved leave must still be recorded in Leave management.</p></div>
        </form>
      </Card>
    </Page>
  );
}
