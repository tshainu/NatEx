import { kgToGrams, parseCsv, rupeesToCents } from "./csv";

/**
 * Merchant bulk-booking CSV → API rows (§10 M3 bulk upload).
 *
 * Pure: no React, no network, so `bulk-csv.test.ts` exercises it directly.
 *
 * Columns are matched by header name, case- and punctuation-insensitive, so a
 * merchant who reorders columns or writes "Consignee Phone" still gets a valid
 * file. Money and weight are converted here, in the browser, by string
 * arithmetic (`rupeesToCents`, `kgToGrams`) — never through a float — and the
 * server then re-validates every row with `bulkRowSchema`.
 */

export interface TemplateColumn {
  key: string;
  header: string;
  required: boolean;
  example: string;
  aliases: string[];
}

export const TEMPLATE_COLUMNS: TemplateColumn[] = [
  { key: "orderRef", header: "order_ref", required: false, example: "ORD-1001", aliases: ["order", "order_id", "reference", "ref"] },
  { key: "consigneeName", header: "consignee_name", required: true, example: "Dilani Perera", aliases: ["name", "customer", "customer_name", "recipient"] },
  { key: "consigneePhone", header: "consignee_phone", required: true, example: "0771234567", aliases: ["phone", "mobile", "customer_phone", "contact"] },
  { key: "destAddress", header: "delivery_address", required: true, example: "No. 12, Temple Road, Kandy", aliases: ["address", "dest_address", "destination"] },
  { key: "weightKg", header: "weight_kg", required: true, example: "0.75", aliases: ["weight", "kg"] },
  { key: "lengthCm", header: "length_cm", required: false, example: "", aliases: ["length"] },
  { key: "widthCm", header: "width_cm", required: false, example: "", aliases: ["width"] },
  { key: "heightCm", header: "height_cm", required: false, example: "", aliases: ["height"] },
  { key: "codRs", header: "cod_rs", required: false, example: "2450.00", aliases: ["cod", "cod_amount", "collect"] },
  { key: "declaredRs", header: "declared_value_rs", required: false, example: "2450.00", aliases: ["declared", "declared_value", "value"] },
];

export const TEMPLATE_HEADER = TEMPLATE_COLUMNS.map((c) => c.header);
export const TEMPLATE_EXAMPLE = TEMPLATE_COLUMNS.map((c) => c.example);

export interface PreparedRow {
  line: number;
  /** The merchant's own cells, by template header — for the error report. */
  source: Record<string, string>;
  /** Payload sent to `parcels.bulkCreate`, or null if the row failed locally. */
  payload: Record<string, unknown> | null;
  errors: { field: string; message: string }[];
}

export interface PreparedFile {
  rows: PreparedRow[];
  /** File-level problems (missing columns, empty file). Nothing is sendable. */
  fileErrors: string[];
  unknownColumns: string[];
}

const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function intCm(raw: string, field: string, errors: PreparedRow["errors"]): number | null {
  const t = raw.trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) {
    errors.push({ field, message: `"${t}" is not a whole number of centimetres` });
    return null;
  }
  return Number(t);
}

export function prepareBulkCsv(text: string): PreparedFile {
  const records = parseCsv(text);
  if (records.length === 0) return { rows: [], fileErrors: ["The file is empty."], unknownColumns: [] };

  const [head, ...body] = records;
  const index = new Map<string, number>();
  const unknownColumns: string[] = [];
  head!.cells.forEach((cell, i) => {
    const h = norm(cell);
    const col = TEMPLATE_COLUMNS.find((c) => c.header === h || c.aliases.includes(h));
    if (col && !index.has(col.key)) index.set(col.key, i);
    else if (h) unknownColumns.push(cell.trim());
  });

  const missing = TEMPLATE_COLUMNS.filter((c) => c.required && !index.has(c.key)).map((c) => c.header);
  if (missing.length) {
    return {
      rows: [],
      fileErrors: [
        `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Download the template to see the expected header row.`,
      ],
      unknownColumns,
    };
  }
  if (body.length === 0) return { rows: [], fileErrors: ["The file has a header row but no parcels."], unknownColumns };

  const seenRefs = new Map<string, number>();
  const rows = body.map(({ cells, line }): PreparedRow => {
    const get = (key: string) => {
      const i = index.get(key);
      return i === undefined ? "" : (cells[i] ?? "").trim();
    };
    const source: Record<string, string> = {};
    for (const c of TEMPLATE_COLUMNS) source[c.header] = get(c.key);

    const errors: PreparedRow["errors"] = [];
    const weight = kgToGrams(get("weightKg"));
    if ("error" in weight) errors.push({ field: "weight_kg", message: weight.error });
    const cod = rupeesToCents(get("codRs"));
    if ("error" in cod) errors.push({ field: "cod_rs", message: cod.error });
    const declared = rupeesToCents(get("declaredRs"));
    if ("error" in declared) errors.push({ field: "declared_value_rs", message: declared.error });
    const lengthCm = intCm(get("lengthCm"), "length_cm", errors);
    const widthCm = intCm(get("widthCm"), "width_cm", errors);
    const heightCm = intCm(get("heightCm"), "height_cm", errors);

    // The server catches a duplicate ref inside one request; the file may span
    // several requests, so the whole-file check has to happen here.
    const orderRef = get("orderRef");
    if (orderRef) {
      const first = seenRefs.get(orderRef);
      if (first !== undefined) errors.push({ field: "order_ref", message: `Duplicate order ref — first used on line ${first}` });
      else seenRefs.set(orderRef, line);
    }

    const payload =
      errors.length === 0
        ? {
            line,
            orderRef: orderRef || null,
            consigneeName: get("consigneeName"),
            consigneePhone: get("consigneePhone"),
            destAddress: get("destAddress"),
            weightGrams: (weight as { grams: number }).grams,
            lengthCm,
            widthCm,
            heightCm,
            codAmountCents: (cod as { cents: number }).cents,
            declaredValueCents: (declared as { cents: number }).cents,
          }
        : null;
    return { line, source, payload, errors };
  });

  return { rows, fileErrors: [], unknownColumns };
}

/** Split into request-sized chunks (server cap: BULK_ROW_LIMIT). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Server field names → the template header the merchant sees. */
export const FIELD_TO_HEADER: Record<string, string> = {
  orderRef: "order_ref",
  consigneeName: "consignee_name",
  consigneePhone: "consignee_phone",
  destAddress: "delivery_address",
  weightGrams: "weight_kg",
  lengthCm: "length_cm",
  widthCm: "width_cm",
  heightCm: "height_cm",
  codAmountCents: "cod_rs",
  declaredValueCents: "declared_value_rs",
};
