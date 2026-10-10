import * as React from "react";
import type { CellValue, Workbook } from "exceljs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, orpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, Page, SuccessNote } from "@/components/natex/page";
import { currentMonthRange, hoursToMinutes, todayInColombo } from "./shared";

const currentRange = currentMonthRange();
function hours(minutes: number): string {
  return (minutes / 60).toFixed(2);
}
function dateString(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  if (typeof value === "number" && value > 20_000) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
    return date.toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  return "";
}
function cellValue(value: CellValue): unknown {
  if (value && typeof value === "object") {
    if ("result" in value && value.result !== undefined) return value.result;
    if ("text" in value) return value.text;
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
  }
  return value;
}
function normalizedHeader(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function parseWorkbook(workbook: Workbook) {
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("The workbook has no worksheet.");
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => headers.set(normalizedHeader(cellValue(cell.value)), column));
  const find = (...names: string[]) => names.map((name) => headers.get(name)).find((index) => index !== undefined);
  const codeCol = find("employee code", "employee id", "staff code");
  const dateCol = find("work date", "date");
  const regularCol = find("regular hours", "regular time", "hours worked");
  const overtimeCol = find("overtime hours", "ot hours", "overtime");
  const notesCol = find("notes", "note", "remarks");
  if (!codeCol || !dateCol || !regularCol || !overtimeCol) {
    throw new Error("Required columns are Employee Code, Work Date, Regular Hours and Overtime Hours. Download the NatEx template for the exact layout.");
  }
  const rows: { employeeCode: string; workDate: string; regularMinutes: number; overtimeMinutes: number; note?: string; source: "excel" }[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const code = String(cellValue(row.getCell(codeCol).value) ?? "").trim().toUpperCase();
    if (!code) return;
    const workDate = dateString(cellValue(row.getCell(dateCol).value));
    const regularMinutes = hoursToMinutes(String(cellValue(row.getCell(regularCol).value) ?? "0"));
    const overtimeMinutes = hoursToMinutes(String(cellValue(row.getCell(overtimeCol).value) ?? "0"));
    if (!workDate || regularMinutes === null || overtimeMinutes === null) throw new Error(`Invalid date or hours on worksheet row ${rowNumber}.`);
    rows.push({
      employeeCode: code,
      workDate,
      regularMinutes,
      overtimeMinutes,
      note: notesCol ? String(cellValue(row.getCell(notesCol).value) ?? "").trim() : "",
      source: "excel",
    });
  });
  if (!rows.length) throw new Error("No timesheet rows with Employee Codes were found.");
  return rows;
}

async function downloadTemplate() {
  const { Workbook: WorkbookClass } = await import("exceljs");
  const workbook = new WorkbookClass();
  const sheet = workbook.addWorksheet("Timesheet Upload");
  sheet.columns = [
    { header: "Employee Code", key: "employeeCode", width: 20 },
    { header: "Work Date", key: "workDate", width: 16 },
    { header: "Regular Hours", key: "regularHours", width: 18 },
    { header: "Overtime Hours", key: "overtimeHours", width: 18 },
    { header: "Notes", key: "notes", width: 36 },
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF176B4D" } };
  sheet.addRows([
    { employeeCode: "", workDate: "", regularHours: "", overtimeHours: "", notes: "" },
    { employeeCode: "", workDate: "", regularHours: "", overtimeHours: "", notes: "" },
  ]);
  const help = workbook.addWorksheet("Instructions");
  help.addRows([
    ["NatEx manual timesheet import"],
    ["Use the first worksheet, Timesheet Upload. Keep the five column headers unchanged."],
    ["Employee Code must match an active NatEx HR employee exactly."],
    ["Use an Excel date or YYYY-MM-DD; record hours as decimals (e.g. 7.5 = 7 hours 30 minutes)."],
    ["Each employee may have only one row per work date. Total regular + overtime time cannot exceed 24 hours."],
    ["Importing replaces an existing employee/date entry. Timesheets are locked while a non-cancelled payroll run covers that date."],
    ["This workbook is a blank basis sheet, not a statutory timesheet ruling. HR must verify the actual hours and employee classification."],
  ]);
  help.getColumn(1).width = 110;
  help.getRow(1).font = { bold: true, size: 14 };
  const buffer = await workbook.xlsx.writeBuffer();
  // ExcelJS returns a Uint8Array/Buffer; use a Blob URL to preserve the binary workbook.
  const blob = new Blob([buffer as unknown as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "NatEx-Timesheet-Template.xlsx";
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function HrTimesheets() {
  const queryClient = useQueryClient();
  const [month, setMonth] = React.useState(currentRange.from.slice(0, 7));
  const [employeeCode, setEmployeeCode] = React.useState("");
  const [workDate, setWorkDate] = React.useState(todayInColombo());
  const [regularHours, setRegularHours] = React.useState("8");
  const [overtimeHours, setOvertimeHours] = React.useState("0");
  const [note, setNote] = React.useState<string | null>(null);
  const [entryNote, setEntryNote] = React.useState("");
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [busyUpload, setBusyUpload] = React.useState(false);
  const [from, to] = React.useMemo(() => {
    const [year, monthPart] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year!, monthPart!, 0)).getUTCDate();
    return [`${month}-01`, `${month}-${String(lastDay).padStart(2, "0")}`];
  }, [month]);
  const rows = useQuery({ ...orpc.hr.timesheets.queryOptions({ input: { from, to } }) });
  const save = useMutation({
    ...orpc.hr.saveTimesheets.mutationOptions(),
    onSuccess: (result) => {
      setNote(`${result.imported} time row(s) saved for ${result.employees} employee(s).`);
      setLocalError(null);
      void queryClient.invalidateQueries({ queryKey: orpc.hr.timesheets.key() });
    },
  });

  function saveManual(event: React.FormEvent) {
    event.preventDefault();
    const regularMinutes = hoursToMinutes(regularHours);
    const overtimeMinutes = hoursToMinutes(overtimeHours);
    if (regularMinutes === null || overtimeMinutes === null) { setLocalError("Enter valid hours between 0 and 24, with no more than two decimal places."); return; }
    setLocalError(null);
    setNote(null);
    save.mutate({ rows: [{ employeeCode: employeeCode.trim().toUpperCase(), workDate, regularMinutes, overtimeMinutes, note: entryNote, source: "manual" }] });
  }

  async function importWorkbook(file?: File) {
    if (!file) return;
    setBusyUpload(true);
    setLocalError(null);
    setNote(null);
    try {
      const { Workbook: WorkbookClass } = await import("exceljs");
      const workbook = new WorkbookClass();
      await workbook.xlsx.load(await file.arrayBuffer());
      const imported = parseWorkbook(workbook);
      save.mutate({ rows: imported });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "The workbook could not be read.");
    } finally {
      setBusyUpload(false);
    }
  }

  return (
    <Page title="Timesheets" description="Enter daily hours manually or upload an Excel basis sheet. Imports are parsed in the browser; NatEx stores validated hour/minute rows, not the workbook itself.">
      {note ? <SuccessNote>{note}</SuccessNote> : null}
      {localError ? <ErrorNote>{localError}</ErrorNote> : null}
      {save.error ? <ErrorNote>{apiMessage(save.error, "Timesheet rows could not be saved.")}</ErrorNote> : null}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Manual entry" description="One employee and one work date per row. Decimal hours are converted to minutes before saving.">
          <form className="grid gap-3 md:grid-cols-2" onSubmit={saveManual}>
            <Field label="Employee code"><Input required value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value.toUpperCase())} /></Field>
            <Field label="Work date"><Input type="date" required value={workDate} onChange={(e) => setWorkDate(e.target.value)} /></Field>
            <Field label="Regular hours"><Input type="number" min="0" max="24" step="0.01" required value={regularHours} onChange={(e) => setRegularHours(e.target.value)} /></Field>
            <Field label="Overtime hours"><Input type="number" min="0" max="24" step="0.01" required value={overtimeHours} onChange={(e) => setOvertimeHours(e.target.value)} /></Field>
            <Field label="Notes" className="md:col-span-2"><Input maxLength={500} value={entryNote} onChange={(e) => setEntryNote(e.target.value)} /></Field>
            <div className="flex gap-2 md:col-span-2"><Button type="submit" pending={save.isPending}>Save time row</Button><Button type="button" variant="outline" onClick={() => void downloadTemplate()}>Download Excel template</Button></div>
          </form>
        </Card>
        <Card title="Upload Excel basis sheet" description="Supported format: .xlsx. The required columns are Employee Code, Work Date, Regular Hours and Overtime Hours; Notes is optional.">
          <div className="space-y-4">
            <Field label="Select workbook"><Input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; void importWorkbook(file); }} disabled={busyUpload || save.isPending} /></Field>
            <Button type="button" variant="outline" pending={busyUpload} onClick={() => void downloadTemplate()}>Download NatEx template</Button>
            <p className="text-[12px] leading-relaxed text-muted-foreground">Duplicate employee/date rows, inactive employee codes, invalid dates, entries over 24 hours, and edits to payroll-locked periods are rejected. Uploading a corrected workbook replaces matching rows.</p>
          </div>
        </Card>
      </div>
      <Card title="Saved timesheets" description="Rows are grouped by Colombo payroll month. Hours recorded during a draft run are locked until the draft is cancelled.">
        <div className="mb-4 flex items-end gap-3"><Field label="Payroll month"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value || currentRange.from.slice(0, 7))} /></Field><span className="pb-2 text-[12px] text-muted-foreground">{from} → {to}</span></div>
        {rows.error ? <ErrorNote>{apiMessage(rows.error, "Timesheets could not be loaded.")}</ErrorNote> : null}
        <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Date</th><th className="p-2">Employee</th><th className="p-2 text-right">Regular</th><th className="p-2 text-right">Overtime</th><th className="p-2">Source</th><th className="p-2">Notes</th></tr></thead><tbody>{(rows.data ?? []).map((row) => <tr key={row.id} className="border-b border-border/60"><td className="p-2 font-mono">{row.workDate}</td><td className="p-2"><span className="font-mono">{row.employeeCode}</span> · {row.fullName}</td><td className="p-2 text-right font-mono">{hours(row.regularMinutes)} h</td><td className="p-2 text-right font-mono">{hours(row.overtimeMinutes)} h</td><td className="p-2"><span className="rounded border px-2 py-0.5 text-[11px]">{row.source}</span></td><td className="p-2">{row.note ?? "—"}</td></tr>)}</tbody></table>{!rows.isPending && (rows.data?.length ?? 0) === 0 ? <p className="py-7 text-center text-[13px] text-muted-foreground">No time rows for this month.</p> : null}</div>
      </Card>
    </Page>
  );
}
