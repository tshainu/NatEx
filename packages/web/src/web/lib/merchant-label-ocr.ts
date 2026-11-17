import { DISTRICTS, PROVINCES, districtFromAddress, provinceForDistrict, type AddressParts } from "./address";

export interface MerchantLabelSuggestions {
  awb: string | null;
  fromAddressText: string | null;
  toAddressText: string | null;
  consigneeName: string | null;
  consigneePhone: string | null;
  destAddress: AddressParts | null;
}

const PHONE_PATTERN = String.raw`(?:\+?94[\s()-]*)?0?7(?:[\s()-]*\d){8}`;
const AWB_TEXT_PATTERN = /(?:^|[^A-Z0-9])NX\s*[:#-]?\s*((?:\d[\s-]*){9}\d)(?!\d)/gi;
const HEADER_PATTERN = /^(from|sender|shipper|pickup|origin|to|receiver|recipient|consignee|delivery|deliver\s+to|delivery\s+to)\s*(?:address)?\s*[:=—-]\s*(.*)$/i;
const STANDALONE_HEADER_PATTERN = /^(from|sender|shipper|pickup|origin|to|receiver|recipient|consignee|delivery|deliver to|delivery to)(?: address)?$/i;
const METADATA_PATTERN = /^(?:awb|tracking(?:\s+(?:number|no\.?))?|waybill|barcode|cod(?:\s+amount)?|weight|dimensions?|order\s+(?:ref|reference|id)|parcel\s+id)\b/i;

function normalizeAwb(value: string): string | null {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = compact.match(/NX\d{10}/);
  return match?.[0] ?? null;
}

function textAwb(text: string): string | null {
  for (const match of text.matchAll(AWB_TEXT_PATTERN)) {
    const digits = match[1]?.replace(/\D/g, "") ?? "";
    if (digits.length === 10) return `NX${digits}`;
  }
  return null;
}

function normalizeSriLankanMobile(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("07")) return digits;
  if (digits.length === 11 && digits.startsWith("947")) return `0${digits.slice(2)}`;
  if (digits.length === 9 && digits.startsWith("7")) return `0${digits}`;
  return null;
}

function phoneFrom(text: string): string | null {
  const candidates = text.match(new RegExp(PHONE_PATTERN, "g")) ?? [];
  for (const candidate of candidates) {
    const normalized = normalizeSriLankanMobile(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function sectionHeader(line: string): { kind: "from" | "to"; content: string } | null {
  const match = line.match(HEADER_PATTERN);
  const standalone = STANDALONE_HEADER_PATTERN.test(line);
  if (!match && !standalone) return null;
  const label = (match?.[1] ?? line).toLowerCase();
  const kind = /^(?:from|sender|shipper|pickup|origin)/.test(label) ? "from" : "to";
  return { kind, content: match?.[2]?.trim() ?? "" };
}

function splitLabelSections(text: string): { from: string[]; to: string[] } {
  const separated = text.replace(
    /\s+(?=(?:from|sender|shipper|pickup|origin|to|receiver|recipient|consignee|delivery|deliver\s+to)\s*(?:address)?\s*[:=—-])/gi,
    "\n",
  );
  const sections: { from: string[]; to: string[] } = { from: [], to: [] };
  let current: "from" | "to" | null = null;

  for (const rawLine of separated.split(/\r?\n/)) {
    const line = rawLine.replace(/^[•·\-\s]+|[\s]+$/g, "").trim();
    if (!line) continue;
    const header = sectionHeader(line);
    if (header) {
      current = header.kind;
      if (header.content) sections[current].push(header.content);
      continue;
    }
    if (METADATA_PATTERN.test(line)) {
      current = null;
      continue;
    }
    if (current) sections[current].push(line);
  }

  return sections;
}

function looksLikeName(value: string): boolean {
  const text = value.replace(/^(?:name|recipient|consignee|receiver)\s*[:=—-]\s*/i, "").trim();
  const words = text.split(/\s+/).filter(Boolean);
  const isKnownLocation = [...DISTRICTS, ...PROVINCES].some((location) => location.toLowerCase() === text.toLowerCase());
  return (
    words.length >= 2 &&
    /^[A-Za-z][A-Za-z.'’ -]*$/.test(text) &&
    !isKnownLocation &&
    !/\b(?:district|province)\b/i.test(text) &&
    !/\b(?:road|rd\.?|street|st\.?|lane|avenue|ave\.?|mawatha|cross|junction|no\.?|number)\b/i.test(text)
  );
}

function cleanPhoneAndName(value: string): string {
  return value
    .replace(new RegExp(PHONE_PATTERN, "g"), " ")
    .replace(/^(?:phone|mobile|telephone|tel|contact)\s*[:=—-]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function addressPartsFromText(text: string): AddressParts {
  const district = districtFromAddress(text) ?? "";
  const province = district ? provinceForDistrict(district) : "";
  let localAddress = text.trim();

  if (province) {
    localAddress = localAddress.replace(
      new RegExp(`(?:,\\s*)?${province.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"),
      "",
    ).trim();
  }
  if (district) {
    localAddress = localAddress.replace(
      new RegExp(`(?:,\\s*)?${district.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+district)?\\s*$`, "i"),
      "",
    ).trim();
  }

  const parts = localAddress.split(/\s*[,;\n]\s*/).map((part) => part.trim()).filter(Boolean);
  return {
    line1: parts[0] ?? "",
    line2: parts.slice(1).join(", "),
    district,
    province,
  };
}

/** Parse only explicit From/To label sections; unlabelled text is not guessed into a recipient address. */
export function parseMerchantLabelText(
  text: string,
  barcodeValue = "",
): MerchantLabelSuggestions {
  const sections = splitLabelSections(text);
  const fromAddressText = sections.from.join(", ").trim() || null;
  const rawTo = sections.to.join("\n").trim();
  const consigneePhone = rawTo ? phoneFrom(rawTo) : null;
  const toSegments = rawTo
    .split(/[\r\n,;|]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  let consigneeName: string | null = null;
  const addressSegments: string[] = [];
  for (const segment of toSegments) {
    const explicitName = segment.match(/^(?:name|recipient|consignee|receiver)\s*[:=—-]\s*(.+)$/i);
    if (!consigneeName && explicitName?.[1]) {
      consigneeName = cleanPhoneAndName(explicitName[1]) || null;
      continue;
    }

    const cleaned = cleanPhoneAndName(segment)
      .replace(/^(?:address|delivery address|to address)\s*[:=—-]?\s*/i, "")
      .trim();
    if (!cleaned) continue;
    if (!consigneeName && looksLikeName(cleaned)) {
      consigneeName = cleaned;
      continue;
    }
    addressSegments.push(cleaned);
  }

  const toAddressText = addressSegments.join(", ").trim() || null;
  const barcodeAwb = normalizeAwb(barcodeValue);
  const awb = barcodeAwb ?? textAwb(text);
  const destAddress = toAddressText ? addressPartsFromText(toAddressText) : null;

  return {
    awb,
    fromAddressText,
    toAddressText,
    consigneeName,
    consigneePhone,
    destAddress,
  };
}
