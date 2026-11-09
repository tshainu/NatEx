import { errors } from "../../shared/errors";
import type { Principal } from "../../shared/auth";
import type { PayrollLineRow, PayrollRunRow } from "./payroll";
import { getPayrollRun } from "./payroll";

interface Snapshot {
  warnings: string[];
  lines: { label: string; kind: "earning" | "deduction"; amountCents: number }[];
  apitScheduleVersion: string;
}

export interface PayslipFile {
  name: string;
  bytes: Uint8Array;
}

function assertPayrollReader(actor: Principal): void {
  if (!actor.roles.some((role) => role === "hr" || role === "finance" || role === "admin")) {
    errors.forbidden("HR/payroll access is required to download payslips.");
  }
}

/** Resolve selection strictly from this stored run; missing employee rows never get synthesized. */
export function selectPayslipLines<T extends Pick<PayrollLineRow, "employeeId" | "employeeCode">>(
  run: Pick<PayrollRunRow, "status" | "periodStart" | "periodEnd">,
  lines: readonly T[],
  employeeIds?: readonly string[],
): T[] {
  if (run.status !== "approved" && run.status !== "paid") {
    errors.conflict("Payslips are available only for approved or paid payroll periods.");
  }
  if (!lines.length) errors.notFound("Payroll records for this period");
  if (employeeIds !== undefined) {
    if (!employeeIds.length) errors.badRequest("Select one employee or all employees in this payroll period.");
    if (employeeIds.length > 5000) errors.badRequest("A bulk payslip download may contain at most 5,000 employees.");
    if (new Set(employeeIds).size !== employeeIds.length) errors.badRequest("The employee selection contains duplicates.");
  }
  const selected = employeeIds === undefined ? [...lines] : lines.filter((line) => employeeIds.includes(line.employeeId));
  if (employeeIds !== undefined && selected.length !== employeeIds.length) errors.notFound("One or more selected employees do not have a payroll record for this period");
  return selected;
}

const utf8 = new TextEncoder();
const asBytes = (value: string) => utf8.encode(value);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
const ascii = (value: string) => value.normalize("NFKD").replace(/[^\x20-\x7E]/g, "?");
const pdfEscape = (value: string) => ascii(value).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
const money = (cents: number) => `LKR ${(cents / 100).toFixed(2)}`;
const safePart = (value: string) => ascii(value).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "employee";

function renderPayslipPdf(run: Pick<PayrollRunRow, "status" | "periodStart" | "periodEnd" | "code">, line: PayrollLineRow): Uint8Array {
  const snapshot = JSON.parse(line.breakdownJson) as Snapshot;
  const status = run.status === "paid" ? "Paid" : "Approved / ready for payment";
  const summary = [
    ["Gross earnings", line.grossCents],
    ["EPF staff deduction (8%)", line.employeeEpfCents],
    ["Earnings after staff EPF", line.grossCents - line.employeeEpfCents],
    ["APIT withheld", line.apitCents],
    ["Other deductions", line.otherDeductionsCents],
    ["Net pay / take-home pay", line.netCents],
    ["Company EPF contribution (12%)", line.employerEpfCents],
    ["Company ETF contribution (3%)", line.employerEtfCents],
  ] as const;
  const rows = [
    "NatEx - PAYSLIP",
    `Payroll run: ${run.code}   Status: ${status}`,
    `Employee: ${line.employeeName}   Employee code: ${line.employeeCode}`,
    `Pay basis: ${line.payBasis}   Pay period: ${run.periodStart} to ${run.periodEnd}`,
    `APIT schedule snapshot: ${snapshot.apitScheduleVersion}`,
    "",
    "PAY / DEDUCTION ITEM                                         AMOUNT (LKR)",
    ...snapshot.lines.map((item) => `${item.label}${item.kind === "deduction" ? " (deduction)" : ""}     ${money(item.amountCents)}`),
    "",
    "EMPLOYEE PAY SUMMARY",
    ...summary.slice(0, 6).map(([label, cents]) => `${label}: ${money(cents)}`),
    "",
    "COMPANY-PAID CONTRIBUTIONS (not deducted from employee pay)",
    ...summary.slice(6).map(([label, cents]) => `${label}: ${money(cents)}`),
    `Total company contributions: ${money(line.employerEpfCents + line.employerEtfCents)}`,
  ];
  if (snapshot.warnings.length) rows.push("", `Review notes: ${snapshot.warnings.join("; ")}`);
  rows.push("", "This payslip is based on the saved payroll record. Statutory submissions remain subject to review.");

  const wrappedRows = rows.flatMap((row) => {
    const result: string[] = [];
    let remaining = row;
    while (remaining.length > 82) {
      let split = remaining.lastIndexOf(" ", 82);
      if (split < 40) split = 82;
      result.push(remaining.slice(0, split));
      remaining = remaining.slice(split).trimStart();
    }
    result.push(remaining);
    return result;
  });
  const linesPerPage = 52;
  const groups: string[][] = [];
  for (let i = 0; i < wrappedRows.length; i += linesPerPage) groups.push(wrappedRows.slice(i, i + linesPerPage));
  const pageObjects = groups.map((_, i) => 4 + i * 2);
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjects.map((id) => `${id} 0 R`).join(" ")}] /Count ${groups.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  groups.forEach((group, i) => {
    const pageId = pageObjects[i]!;
    const streamId = pageId + 1;
    const commands = ["BT", "/F1 10 Tf", "48 790 Td", "14 TL", ...group.flatMap((row) => [`(${pdfEscape(row)}) Tj`, "T*"]), "ET"].join("\n");
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`;
    objects[streamId] = `<< /Length ${asBytes(commands).length} >>\nstream\n${commands}\nendstream`;
  });
  let document = "%PDF-1.4\n%NatEx\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = asBytes(document).length;
    document += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = asBytes(document).length;
  document += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) document += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return asBytes(document);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of data) crc = CRC_TABLE[(crc ^ value) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function u16(value: number): Uint8Array { return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]); }
function u32(value: number): Uint8Array { return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]); }

/** Create a ZIP with uncompressed, UTF-8-named PDF entries; no external library required. */
export function createZip(files: readonly PayslipFile[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const directoryParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = utf8.encode(file.name);
    const checksum = crc32(file.bytes);
    const localHeader = concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(1), u32(checksum), u32(file.bytes.length), u32(file.bytes.length), u16(name.length), u16(0), name);
    localParts.push(localHeader, file.bytes);
    directoryParts.push(concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(1), u32(checksum), u32(file.bytes.length), u32(file.bytes.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localOffset), name));
    localOffset += localHeader.length + file.bytes.length;
  }
  const directory = concat(...directoryParts);
  const end = concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(directory.length), u32(localOffset), u16(0));
  return concat(...localParts, directory, end);
}

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    result += alphabet[a >>> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >>> 4)] + (b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >>> 6)]) + (c === undefined ? "=" : alphabet[c & 63]);
  }
  return result;
}

export function createPayslipFiles(run: Pick<PayrollRunRow, "id" | "code" | "status" | "periodStart" | "periodEnd">, lines: readonly PayrollLineRow[]): PayslipFile[] {
  return lines.map((line) => ({
    name: `NatEx-Payslip-${safePart(run.periodStart.slice(0, 7))}-${safePart(line.employeeCode)}.pdf`,
    bytes: renderPayslipPdf(run, line),
  }));
}

export async function exportPayslips(input: { runId: string; employeeIds?: string[] }, actor: Principal) {
  assertPayrollReader(actor);
  const detail = await getPayrollRun(input.runId, actor);
  const lines = selectPayslipLines(detail.run, detail.lines, input.employeeIds);
  const files = createPayslipFiles(detail.run, lines);
  const single = files.length === 1;
  const bytes = single ? files[0]!.bytes : createZip(files);
  return {
    fileName: single ? files[0]!.name : `NatEx-Payslips-${safePart(detail.run.periodStart.slice(0, 7))}.zip`,
    contentType: single ? "application/pdf" : "application/zip",
    contentBase64: base64(bytes),
    fileCount: files.length,
    periodStart: detail.run.periodStart,
    periodEnd: detail.run.periodEnd,
  };
}
