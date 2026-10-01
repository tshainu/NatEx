/**
 * CSV in and out of the browser (§11: every list exports to CSV; §10 M3: bulk
 * booking by CSV upload).
 *
 * Export follows RFC 4180: every field quoted when it contains a comma, quote or
 * line break, quotes doubled, CRLF row endings, and a UTF-8 BOM so Excel on a
 * Windows desk in Colombo opens Sinhala and Tamil names without mojibake.
 *
 * Money never passes through a float here. `centsToRupees` formats integer cents
 * as "1234.50" by integer arithmetic, and `rupeesToCents` parses a typed rupee
 * amount by splitting on the decimal point — "12,345.67" becomes 1234567 exactly,
 * and "10.005" is refused rather than rounded.
 */

export type CsvCell = string | number | boolean | null | undefined;

function quote(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  const text = String(cell);
  // Formula injection guard: a cell that Excel would evaluate is prefixed with
  // an apostrophe. A consignee name of "=HYPERLINK(...)" is data, not a formula.
  // Plain signed numbers (−250, +94771234567) are left alone: they are values,
  // not formulas, and an apostrophe would corrupt them for a script reading back.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^[+-]?\d[\d.]*$/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return [header, ...rows].map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n";
}

export function downloadCsv(filename: string, header: string[], rows: CsvCell[][]): void {
  const blob = new Blob(["﻿", toCsv(header, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Parse RFC 4180 text into rows of strings. Handles quoted fields with embedded
 * commas, doubled quotes and line breaks; strips a leading BOM; drops trailing
 * blank lines. Returns the raw physical line each record started on so a
 * validation error can say "line 14" and mean the line the merchant sees in
 * their spreadsheet.
 */
export function parseCsv(text: string): { cells: string[]; line: number }[] {
  const src = text.replace(/^﻿/, "");
  const out: { cells: string[]; line: number }[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // swallowed; \n ends the row
    } else if (ch === "\n") {
      row.push(field);
      out.push({ cells: row, line: rowLine });
      row = [];
      field = "";
      line += 1;
      rowLine = line;
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    out.push({ cells: row, line: rowLine });
  }
  return out.filter((r) => r.cells.some((c) => c.trim().length > 0));
}

/** Integer cents → "1234.50". No division, no float. */
export function centsToRupees(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

/**
 * A typed rupee amount → integer cents, or an error sentence.
 * Accepts "1250", "1,250", "1250.5", "Rs. 1,250.50". Refuses a third decimal
 * place, a negative, and anything that is not a number — it never rounds.
 */
export function rupeesToCents(raw: string): { cents: number } | { error: string } {
  const text = raw.trim().replace(/^rs\.?\s*/i, "").replace(/,/g, "");
  if (text === "") return { cents: 0 };
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { error: `"${raw.trim()}" is not an amount in rupees.` };
  }
  const [whole, frac = ""] = text.split(".");
  if (frac.length > 2) {
    return { error: `"${raw.trim()}" has more than two decimal places — cents cannot be split.` };
  }
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return { error: `"${raw.trim()}" is too large.` };
  return { cents };
}

/**
 * Walk a server-paginated list to the end and hand back every row, for export.
 * Capped so a mis-filtered export cannot pull the whole database into a tab.
 */
export async function collectPages<T>(
  fetchPage: (page: number) => Promise<{ rows: T[]; total: number; pageSize: number }>,
  maxRows = 5000,
): Promise<{ rows: T[]; truncated: boolean; total: number }> {
  const rows: T[] = [];
  let page = 1;
  let total = 0;
  for (;;) {
    const result = await fetchPage(page);
    total = result.total;
    rows.push(...result.rows);
    if (rows.length >= total || result.rows.length === 0) break;
    if (rows.length >= maxRows) return { rows: rows.slice(0, maxRows), truncated: true, total };
    page += 1;
  }
  return { rows, truncated: false, total };
}

/**
 * A typed weight in kilograms → integer grams, or an error sentence. Same
 * string arithmetic as `rupeesToCents`: "1.25" is 1250 g exactly, a fourth
 * decimal place is refused rather than rounded.
 */
export function kgToGrams(raw: string): { grams: number } | { error: string } {
  const text = raw.trim().replace(/\s*kg$/i, "").replace(/,/g, "");
  if (text === "") return { error: "Weight is required." };
  if (!/^\d+(\.\d+)?$/.test(text)) return { error: `"${raw.trim()}" is not a weight in kg.` };
  const [whole, frac = ""] = text.split(".");
  if (frac.length > 3) return { error: `"${raw.trim()}" is finer than a gram.` };
  const grams = Number(whole) * 1000 + Number(frac.padEnd(3, "0"));
  if (!Number.isSafeInteger(grams)) return { error: `"${raw.trim()}" is too large.` };
  return { grams };
}
