export type DistrictGroups = Readonly<Record<string, readonly string[]>>;

export interface MerchantLabelAddressSuggestion {
  line1: string | null;
  line2: string | null;
  district: string | null;
  province: string | null;
}

export interface MerchantLabelSuggestions {
  awb: string | null;
  senderAddressText: string | null;
  toAddressText: string | null;
  consigneeName: string | null;
  consigneePhone: string | null;
  destinationAddress: MerchantLabelAddressSuggestion | null;
  recognizedText: string;
}

const PHONE_PATTERN = /(?:\+?94|0094)?[\s().-]*0?7(?:[\s().-]*\d){8}/;
const PHONE_PATTERN_GLOBAL = /(?:\+?94|0094)?[\s().-]*0?7(?:[\s().-]*\d){8}/g;
const METADATA_LINE = /^(?:awb|tracking(?:\s+(?:number|no\.?))?|waybill|cod|weight|dimensions?|pieces|invoice|order\s+ref(?:erence)?)\b/i;
const FIELD_LINE = /^(?:phone|mobile|tel(?:ephone)?|contact)\s*[-:]/i;

function normalizeOcrLines(blocks: readonly string[]): string[] {
  const lines = blocks.flatMap((block) => block.split(/\r?\n/));
  const normalized: string[] = [];
  for (const line of lines) {
    const clean = line.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
    if (!clean) continue;
    normalized.push(...splitInlineSections(clean));
  }
  return normalized;
}

function splitInlineSections(line: string): string[] {
  const marker = /\b(from|sender|shipper|to|recipient|consignee|receiver)\s*:/gi;
  const matches = [...line.matchAll(marker)];
  if (matches.length < 2) return [line];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? line.length;
    return `${match[1]}: ${line.slice(start, end).trim()}`;
  });
}

function normalizeAwb(value: string): string | null {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.match(/NX\d{10}/)?.[0] ?? null;
}

function findAwb(barcodeValues: readonly string[], lines: readonly string[]): string | null {
  for (const value of [...barcodeValues, ...lines]) {
    const awb = normalizeAwb(value);
    if (awb) return awb;
  }
  return null;
}

function extractSections(lines: readonly string[]) {
  const from: string[] = [];
  const to: string[] = [];
  let section: "from" | "to" | null = null;

  for (const line of lines) {
    const fromHeading = line.match(/^(?:from|sender|shipper|pickup|origin)(?:\s+address)?\s*(?::|[-–]|$)\s*(.*)$/i);
    if (fromHeading) {
      section = "from";
      if (fromHeading[1]) from.push(fromHeading[1].trim());
      continue;
    }
    const toHeading = line.match(/^(?:to|recipient|consignee|receiver|ship\s+to|deliver\s+to|delivery\s+address|destination)(?:\s+address)?\s*(?::|[-–]|$)\s*(.*)$/i);
    if (toHeading) {
      section = "to";
      if (toHeading[1]) to.push(toHeading[1].trim());
      continue;
    }
    if (METADATA_LINE.test(line)) {
      section = null;
      continue;
    }
    if (section === "from") from.push(line);
    if (section === "to") to.push(line);
  }

  return { from, to };
}

function normalizeSriLankanPhone(text: string): string | null {
  const match = text.match(PHONE_PATTERN);
  if (!match) return null;
  let digits = match[0].replace(/\D/g, "");
  if (digits.startsWith("0094")) digits = digits.slice(2);
  if (digits.startsWith("94")) digits = digits.slice(2);
  if (digits.length === 9 && digits.startsWith("7")) digits = `0${digits}`;
  return /^07\d{8}$/.test(digits) ? digits : null;
}

function isPhoneLine(text: string): boolean {
  return FIELD_LINE.test(text) && normalizeSriLankanPhone(text) !== null;
}

function stripFieldPrefix(text: string): string {
  return text
    .replace(/^(?:address|delivery\s+address|ship\s+to|name|recipient\s+name|consignee\s+name)\s*[-:]\s*/i, "")
    .replace(/^(?:phone|mobile|tel(?:ephone)?|contact)\s*[-:]\s*/i, "")
    .trim();
}

function districtAndProvince(text: string, groups: DistrictGroups) {
  const lower = text.toLocaleLowerCase();
  let district: string | null = null;
  let districtIndex = -1;
  for (const districts of Object.values(groups)) {
    for (const item of districts) {
      const index = lower.lastIndexOf(item.toLocaleLowerCase());
      if (index > districtIndex && isWordMatch(lower, item, index)) {
        district = item;
        districtIndex = index;
      }
    }
  }

  let province = Object.keys(groups).find((item) => new RegExp(`\\b${escapeRegExp(item)}\\b`, "i").test(text)) ?? null;
  if (!province && district) {
    province = Object.entries(groups).find(([, districts]) => districts.includes(district!))?.[0] ?? null;
  }
  return { district, province };
}

function isWordMatch(text: string, value: string, index: number): boolean {
  const before = index === 0 || !/[A-Za-z0-9]/.test(text[index - 1] ?? "");
  const afterIndex = index + value.length;
  const after = afterIndex >= text.length || !/[A-Za-z0-9]/.test(text[afterIndex] ?? "");
  return before && after;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLocationOnlySegment(text: string, groups: DistrictGroups): boolean {
  const normalized = text.toLocaleLowerCase().replace(/[^A-Za-z0-9]+/g, " ").trim();
  const districtNames = Object.values(groups).flat();
  const provinceNames = Object.keys(groups);
  return [...districtNames, ...provinceNames].some((item) => {
    const candidate = item.toLocaleLowerCase().replace(/[^A-Za-z0-9]+/g, " ").trim();
    return normalized === candidate || normalized === `${candidate} district`;
  });
}

function extractToFields(toLines: readonly string[], groups: DistrictGroups) {
  if (toLines.length === 0) {
    return {
      toAddressText: null,
      consigneeName: null,
      consigneePhone: null,
      destinationAddress: null,
    };
  }

  const toAddressText = toLines.join("\n");
  const labelledName = toLines
    .map((line) => line.match(/^(?:name|recipient\s+name|consignee\s+name)\s*[-:]\s*(.+)$/i)?.[1]?.trim() ?? null)
    .find(Boolean) ?? null;
  const consigneePhone = toLines.map(normalizeSriLankanPhone).find(Boolean) ?? null;

  const rawSegments = toLines.flatMap((line) => line.split(/[,;|]/));
  let consigneeName = labelledName;
  const addressSegments: string[] = [];
  for (const raw of rawSegments) {
    let segment = stripFieldPrefix(raw);
    if (!segment || /^(?:name|recipient\s+name|consignee\s+name)\s*[-:]/i.test(raw)) continue;
    if (FIELD_LINE.test(raw) || isPhoneLine(raw)) continue;
    segment = segment.replace(PHONE_PATTERN_GLOBAL, " ").replace(/\s+/g, " ").trim();
    segment = segment.replace(/^(?:phone|mobile|tel(?:ephone)?|contact)\s*[-:]?\s*/i, "").trim();
    if (!segment) continue;

    if (!consigneeName && looksLikePersonName(segment, groups)) {
      consigneeName = segment;
      continue;
    }
    if (!isLocationOnlySegment(segment, groups)) addressSegments.push(segment);
  }

  const joinedAddress = toLines.join(", ");
  const { district, province } = districtAndProvince(joinedAddress, groups);
  const destinationAddress = addressSegments.length > 0 || district
    ? {
        line1: addressSegments[0] ?? null,
        line2: addressSegments.slice(1).join(", ") || null,
        district,
        province,
      }
    : null;

  return { toAddressText, consigneeName, consigneePhone, destinationAddress };
}

function looksLikePersonName(text: string, groups: DistrictGroups): boolean {
  if (/\d/.test(text) || normalizeSriLankanPhone(text)) return false;
  if (/\b(?:road|rd\.?|street|st\.?|lane|cross|address|near|opposite|behind|phone|mobile|tel)\b/i.test(text)) return false;
  if (isLocationOnlySegment(text, groups)) return false;
  const words = text.match(/[A-Za-z][A-Za-z.'’-]*/g) ?? [];
  return words.length >= 2 && words.length <= 6;
}

export function parseMerchantLabelText(
  textBlocks: readonly string[],
  barcodeValues: readonly string[],
  districtsByProvince: DistrictGroups,
): MerchantLabelSuggestions {
  const lines = normalizeOcrLines(textBlocks);
  const sections = extractSections(lines);
  const senderAddressText = sections.from
    .map((line) => line.replace(PHONE_PATTERN_GLOBAL, " ").replace(/^(?:phone|mobile|tel(?:ephone)?|contact)\s*[-:]?\s*/i, "").trim())
    .filter(Boolean)
    .join("\n") || null;
  const recipient = extractToFields(sections.to, districtsByProvince);

  return {
    awb: findAwb(barcodeValues, lines),
    senderAddressText,
    ...recipient,
    recognizedText: lines.join("\n"),
  };
}

export function mergeMerchantLabelSuggestions(
  current: MerchantLabelSuggestions,
  closeUp: MerchantLabelSuggestions,
): MerchantLabelSuggestions {
  const currentAddress = current.destinationAddress;
  const closeUpAddress = closeUp.destinationAddress;
  const destinationAddress = currentAddress || closeUpAddress
    ? {
        line1: closeUpAddress?.line1 ?? currentAddress?.line1 ?? null,
        line2: closeUpAddress?.line2 ?? currentAddress?.line2 ?? null,
        district: closeUpAddress?.district ?? currentAddress?.district ?? null,
        province: closeUpAddress?.province ?? currentAddress?.province ?? null,
      }
    : null;
  const toAddressText = [current.toAddressText, closeUp.toAddressText]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
    .join("\n");

  return {
    awb: current.awb ?? closeUp.awb,
    senderAddressText: current.senderAddressText ?? closeUp.senderAddressText,
    toAddressText: toAddressText || null,
    consigneeName: closeUp.consigneeName ?? current.consigneeName,
    consigneePhone: closeUp.consigneePhone ?? current.consigneePhone,
    destinationAddress,
    recognizedText: [current.recognizedText, closeUp.recognizedText]
      .filter(Boolean)
      .join("\n"),
  };
}
