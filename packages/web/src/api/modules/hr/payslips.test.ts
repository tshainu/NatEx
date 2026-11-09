import { describe, expect, test } from "bun:test";
import type { Principal } from "../../shared/auth";
import type { PayrollLineRow, PayrollRunRow } from "./payroll";
import { createPayslipFiles, createZip, exportPayslips, selectPayslipLines } from "./payslips";

const period = { periodStart: "2026-10-01", periodEnd: "2026-10-31" };
const lines = [
  { employeeId: "employee-a", employeeCode: "N26001" },
  { employeeId: "employee-b", employeeCode: "N26002" },
];
const run = { id: "run-1", code: "PAY-202610-ABC123", status: "approved", ...period } as PayrollRunRow;
const savedLine = {
  id: "line-1", runId: run.id, employeeId: lines[0]!.employeeId, employeeCode: lines[0]!.employeeCode,
  employeeName: "Fixture Employee", epfNumber: null, payBasis: "monthly", grossCents: 5_000_000,
  epfBaseCents: 5_000_000, etfBaseCents: 5_000_000, apitBaseCents: 5_000_000, employeeEpfCents: 400_000,
  employerEpfCents: 600_000, employerEtfCents: 150_000, apitCents: 50_000, otherDeductionsCents: 100_000,
  netCents: 4_450_000, breakdownJson: JSON.stringify({
    warnings: [], apitScheduleVersion: "snapshot-v1",
    lines: [{ label: "Base pay", kind: "earning", amountCents: 5_000_000 }, { label: "Loan recovery", kind: "deduction", amountCents: 100_000 }],
  }), createdAt: new Date(0),
} as PayrollLineRow;

function readZipNames(zip: Uint8Array): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  const names: string[] = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    names.push(decoder.decode(zip.subarray(offset + 30, offset + 30 + nameLength)));
    offset += 30 + nameLength + extraLength + size;
  }
  return names;
}

describe("HR payslip export selection", () => {
  test("selects exactly one stored employee line or every line for the specified payroll period", () => {
    expect(selectPayslipLines({ ...period, status: "approved" }, lines, ["employee-b"])).toEqual([lines[1]]);
    expect(selectPayslipLines({ ...period, status: "paid" }, lines)).toEqual(lines);
  });

  test("does not return a fabricated line when the selected employee has no payroll record", () => {
    expect(() => selectPayslipLines({ ...period, status: "approved" }, lines, ["not-in-run"])).toThrow("do not have a payroll record");
    expect(() => selectPayslipLines({ ...period, status: "approved" }, [], undefined)).toThrow("Payroll records");
  });

  test("rejects drafts, submitted periods, empty selections, and duplicate employee IDs", () => {
    for (const status of ["draft", "submitted", "cancelled"]) {
      expect(() => selectPayslipLines({ ...period, status }, lines)).toThrow("only for approved or paid");
    }
    expect(() => selectPayslipLines({ ...period, status: "approved" }, lines, [])).toThrow("Select one employee or all employees");
    expect(() => selectPayslipLines({ ...period, status: "approved" }, lines, ["employee-a", "employee-a"])).toThrow("duplicates");
  });

  test("denies a caller without a payroll role before reading any run data", async () => {
    const actor: Principal = { userId: "user-rider", name: "Rider", role: "rider", roles: ["rider"], branchId: "branch-1" };
    await expect(exportPayslips({ runId: "does-not-exist" }, actor)).rejects.toThrow("HR/payroll access is required");
  });
});

describe("saved payslip PDF and ZIP output", () => {
  test("renders stored snapshot amounts and creates one PDF per selected employee", () => {
    const files = createPayslipFiles(run, [savedLine]);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toContain("N26001.pdf");
    const pdf = new TextDecoder().decode(files[0]!.bytes);
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("Fixture Employee");
    expect(pdf).toContain("2026-10-01 to 2026-10-31");
    expect(pdf).toContain("LKR 44500.00");
    expect(pdf).toContain("LKR 6000.00");
    expect(pdf).toContain("snapshot-v1");
    expect(pdf).toContain("Loan recovery \\(deduction\\)");
    expect(pdf).toContain("xref");
  });

  test("creates a ZIP with distinct per-employee PDF entries", () => {
    const files = createPayslipFiles(run, [savedLine, { ...savedLine, id: "line-2", employeeId: "employee-b", employeeCode: "N26002", employeeName: "Second Fixture" }]);
    const zip = createZip(files);
    expect(Array.from(zip.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(Array.from(zip.subarray(-22, -18))).toEqual([0x50, 0x4b, 0x05, 0x06]);
    expect(readZipNames(zip)).toEqual(["NatEx-Payslip-2026-10-N26001.pdf", "NatEx-Payslip-2026-10-N26002.pdf"]);
  });
});
