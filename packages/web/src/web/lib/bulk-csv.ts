import { kgToGrams, parseCsv, rupeesToCents } from "./csv";
import { DISTRICTS_BY_PROVINCE, formatAddress, type AddressParts, type District, type Province } from "./address";

/**
 * Merchant bulk-booking CSV → API rows (§10 M3 bulk upload).
 * Pure: no React, no network, so `bulk-csv.test.ts` exercises it directly.
 * Legacy `delivery_address` remains accepted; the downloaded template uses
 * structured destination-address columns and requires a preprinted AWB sticker.
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
  { key: "awb", header: "awb", required: true, example: "NX1234567890", aliases: ["awb_number", "label_number", "sticker"] },
  { key: "consigneeName", header: "consignee_name", required: true, example: "Meena Ganesan", aliases: ["name", "customer", "customer_name", "recipient"] },
  { key: "consigneePhone", header: "consignee_phone", required: true, example: "0771234567", aliases: ["phone", "mobile", "customer_phone", "contact"] },
  { key: "addressLine1", header: "address_line1", required: false, example: "No. 12, Temple Road", aliases: ["line1", "address_1", "address_line_1", "street_address"] },
  { key: "addressLine2", header: "address_line2", required: false, example: "Near the clock tower", aliases: ["line2", "address_2", "address_line_2", "landmark"] },
  { key: "district", header: "district", required: false, example: "Kandy", aliases: ["delivery_district"] },
  { key: "province", header: "province", required: false, example: "Central Province", aliases: ["delivery_province"] },
  { key: "destAddress", header: "delivery_address", required: false, example: "", aliases: ["address", "dest_address", "destination"] },
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
  source: Record<string, string>;
  payload: Record<string, unknown> | null;
  errors: { field: string; message: string }[];
}

export interface PreparedFile {
  rows: PreparedRow[];
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

function canonicalAddress(row: (key: string) => string, errors: PreparedRow["errors"]): string {
  const legacy = row("destAddress");
  const line1 = row("addressLine1");
  const line2 = row("addressLine2");
  const rawDistrict = row("district");
  const rawProvince = row("province");
  const hasStructured = Boolean(line1 || line2 || rawDistrict || rawProvince);
  if (!hasStructured) {
    if (!legacy) errors.push({ field: "destAddress", message: "Enter address_line1, district and province (or a legacy delivery_address)." });
    return legacy;
  }

  const province = (Object.keys(DISTRICTS_BY_PROVINCE) as Province[])
    .find((item) => item.toLowerCase() === rawProvince.toLowerCase()) ?? "";
  const district = Object.values(DISTRICTS_BY_PROVINCE).flat()
    .find((item) => item.toLowerCase() === rawDistrict.toLowerCase()) ?? "";
  const validDistrict = province && district && (DISTRICTS_BY_PROVINCE[province] as readonly string[]).includes(district);
  if (!line1.trim()) errors.push({ field: "addressLine1", message: "Address line 1 is required." });
  if (!province) errors.push({ field: "province", message: "Choose a valid Sri Lankan province." });
  if (!district) errors.push({ field: "district", message: "Choose a valid Sri Lankan district." });
  else if (province && !validDistrict) errors.push({ field: "district", message: "This district does not belong to the selected province." });
  if (!line1.trim() || !province || !district || !validDistrict) return "";
  const parts: AddressParts = { line1, line2, district: district as District, province };
  return formatAddress(parts);
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
  const hasStructuredAddress = index.has("addressLine1") && index.has("district") && index.has("province");
  if (!index.has("destAddress") && !hasStructuredAddress) {
    missing.push("delivery_address or address_line1 + district + province");
  }
  if (missing.length) {
    return {
      rows: [],
      fileErrors: [`Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Download the template to see the expected header row.`],
      unknownColumns,
    };
  }
  if (body.length === 0) return { rows: [], fileErrors: ["The file has a header row but no parcels."], unknownColumns };

  const seenRefs = new Map<string, number>();
  const seenAwbs = new Map<string, number>();
  const rows = body.map(({ cells, line }): PreparedRow => {
    const get = (key: string) => {
      const i = index.get(key);
      return i === undefined ? "" : (cells[i] ?? "").trim();
    };
    const source: Record<string, string> = {};
    for (const c of TEMPLATE_COLUMNS) source[c.header] = get(c.key);

    const errors: PreparedRow["errors"] = [];
    const awb = get("awb").toUpperCase();
    if (!/^NX\d{10}$/.test(awb)) errors.push({ field: "awb", message: "Enter the 12-character AWB printed on an allocated NatEx sticker." });
    else {
      const first = seenAwbs.get(awb);
      if (first !== undefined) errors.push({ field: "awb", message: `Duplicate AWB — first used on line ${first}.` });
      else seenAwbs.set(awb, line);
    }
    const destAddress = canonicalAddress(get, errors);
    const weight = kgToGrams(get("weightKg"));
    if ("error" in weight) errors.push({ field: "weight_kg", message: weight.error });
    const cod = rupeesToCents(get("codRs"));
    if ("error" in cod) errors.push({ field: "cod_rs", message: cod.error });
    const declared = rupeesToCents(get("declaredRs"));
    if ("error" in declared) errors.push({ field: "declared_value_rs", message: declared.error });
    const lengthCm = intCm(get("lengthCm"), "length_cm", errors);
    const widthCm = intCm(get("widthCm"), "width_cm", errors);
    const heightCm = intCm(get("heightCm"), "height_cm", errors);
    const orderRef = get("orderRef");
    if (orderRef) {
      const first = seenRefs.get(orderRef);
      if (first !== undefined) errors.push({ field: "order_ref", message: `Duplicate order ref — first used on line ${first}` });
      else seenRefs.set(orderRef, line);
    }

    const payload = errors.length === 0 ? {
      line,
      awb,
      orderRef: orderRef || null,
      consigneeName: get("consigneeName"),
      consigneePhone: get("consigneePhone"),
      destAddress,
      weightGrams: (weight as { grams: number }).grams,
      lengthCm,
      widthCm,
      heightCm,
      codAmountCents: (cod as { cents: number }).cents,
      declaredValueCents: (declared as { cents: number }).cents,
    } : null;
    return { line, source, payload, errors };
  });

  return { rows, fileErrors: [], unknownColumns };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const FIELD_TO_HEADER: Record<string, string> = {
  orderRef: "order_ref",
  awb: "awb",
  consigneeName: "consignee_name",
  consigneePhone: "consignee_phone",
  destAddress: "delivery_address",
  addressLine1: "address_line1",
  district: "district",
  province: "province",
  weightGrams: "weight_kg",
  lengthCm: "length_cm",
  widthCm: "width_cm",
  heightCm: "height_cm",
  codAmountCents: "cod_rs",
  declaredValueCents: "declared_value_rs",
};
