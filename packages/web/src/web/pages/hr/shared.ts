export const HR_CONTROL_CLASS = "flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm outline-none focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/30";

export function lkrToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,10}(?:\.\d{0,2})?$/.test(trimmed)) return null;
  const [rupees, fraction = ""] = trimmed.split(".");
  const cents = Number(rupees) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function centsToLkr(value: number): string {
  const rupees = Math.floor(value / 100);
  const cents = Math.abs(value % 100).toString().padStart(2, "0");
  return `${rupees}.${cents}`;
}

export function todayInColombo(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function currentMonthRange(): { from: string; to: string } {
  const today = todayInColombo();
  const [year, month] = today.split("-");
  const end = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return { from: `${year}-${month}-01`, to: `${year}-${month}-${String(end).padStart(2, "0")}` };
}

export function downloadText(filename: string, text: string, type = "text/plain;charset=utf-8"): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function downloadCsv(filename: string, rows: readonly (readonly unknown[])[]): void {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  downloadText(filename, `\uFEFF${csv}`, "text/csv;charset=utf-8");
}

export function hoursToMinutes(value: string): number | null {
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const minutes = Math.round(Number(value) * 60);
  return Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : null;
}
