const CASE_SENSITIVE_NAME = /(?:^|-)(?:e?mail|password|passwd|passcode|username|login|awb|tracking(?:-?(?:number|no))?|parcel(?:-?(?:id|no))?|barcode|serial(?:-?number)?|code|reference|ref|token|secret|api-?key|otp|mfa|pin|nic|national-?(?:id|identity)|account(?:-?(?:number|no))?|iban|swift|ifsc|vat-?no?|tax-?(?:id|no)|vehicle-?(?:registration|number|no)|registration-?(?:id|number|no)|status|state|role|policy|method|mode|channel|enum|template|message|body)(?:-|$)/i;
const NON_TEXT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "date",
  "datetime-local",
  "email",
  "file",
  "hidden",
  "image",
  "month",
  "number",
  "password",
  "radio",
  "range",
  "reset",
  "search",
  "submit",
  "tel",
  "time",
  "url",
  "week",
]);

/** Title-case Unicode words while keeping spaces and punctuation as entered. */
export function titleCaseText(value: string): string {
  return value
    .toLocaleLowerCase("en")
    .replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_match, boundary: string, letter: string) =>
      `${boundary}${letter.toLocaleUpperCase("en")}`,
    );
}

function normaliseFieldName(value: string | undefined): string {
  return (value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function shouldTitleCaseField(options: {
  type?: string;
  name?: string;
  id?: string;
  autoComplete?: string;
  autoCapitalize?: string;
  caseFormat?: string;
  className?: string;
}): boolean {
  if (options.caseFormat === "none") return false;
  if (options.caseFormat === "title") return true;
  const type = (options.type ?? "text").toLowerCase();
  if (
    NON_TEXT_TYPES.has(type) ||
    ["none", "characters"].includes(options.autoCapitalize?.toLowerCase() ?? "") ||
    options.className?.split(/\s+/).includes("font-mono")
  ) return false;
  if (/password|username|email|one-time-code|cc-number|cc-csc|tel/i.test(options.autoComplete ?? "")) return false;
  const field = `${normaliseFieldName(options.name)}-${normaliseFieldName(options.id)}`;
  return !CASE_SENSITIVE_NAME.test(field);
}

/** Preserve the caret position while applying casing in an input event handler. */
export function formatTextControl(control: HTMLInputElement | HTMLTextAreaElement): void {
  const value = control.value;
  const selectionStart = control.selectionStart;
  const selectionEnd = control.selectionEnd;
  const formatted = titleCaseText(value);
  if (formatted === value) return;

  const nextStart = selectionStart === null ? null : titleCaseText(value.slice(0, selectionStart)).length;
  const nextEnd = selectionEnd === null ? null : titleCaseText(value.slice(0, selectionEnd)).length;
  control.value = formatted;
  if (nextStart !== null && nextEnd !== null) {
    try {
      control.setSelectionRange(nextStart, nextEnd);
    } catch {
      // Some input types do not expose selection ranges; they are excluded above.
    }
  }
}
