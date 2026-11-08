/**
 * Shared validation for printable NatEx contact metadata.
 *
 * Contacts are intentionally stored as entered (apart from whitespace cleanup):
 * landlines and mobiles may use different local formatting. This helper rejects
 * labels, control characters and implausibly short/long values without inventing
 * or normalising a business number.
 */

export const RECEIPT_PHONE_MAX_LENGTH = 40;

export function cleanOptionalReceiptPhone(input: string | null | undefined): string | null {
  if (input == null) return null;
  const value = input.trim().replace(/\s+/g, " ");
  return value || null;
}

export function receiptPhoneProblem(input: string | null | undefined): string | null {
  const value = cleanOptionalReceiptPhone(input);
  if (value === null) return null;
  if (value.length > RECEIPT_PHONE_MAX_LENGTH) return `Telephone must be at most ${RECEIPT_PHONE_MAX_LENGTH} characters.`;
  if (!/^[+()\d .-]+$/.test(value)) return "Telephone may contain only digits, spaces, +, -, parentheses and periods.";
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7) return "Telephone must contain at least 7 digits.";
  if (digits.length > 15) return "Telephone must contain at most 15 digits.";
  return null;
}

export function cleanOptionalReceiptWebsite(input: string | null | undefined): string | null {
  if (input == null) return null;
  const value = input.trim().replace(/\s+/g, " ");
  return value || null;
}

export function receiptWebsiteProblem(input: string | null | undefined): string | null {
  const value = cleanOptionalReceiptWebsite(input);
  if (value === null) return null;
  if (value.length > 200) return "Website must be at most 200 characters.";
  const hasControlCharacter = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (hasControlCharacter || /\s/.test(value)) return "Website must be a single address without spaces or control characters.";
  return null;
}
