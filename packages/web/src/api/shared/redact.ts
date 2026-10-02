/**
 * Audit redaction (§5: the audit log is read far more widely than the payout
 * table — every finance and admin user, and the M5 audit viewer).
 *
 * `writeAudit` passes every before/after payload through `redactForAudit`, so a
 * route that audits its whole response (pipeline `mutate()` does exactly that)
 * cannot leak a bank account, a session token or a full payout file into the
 * log. Keys are matched case-insensitively, at any depth:
 *   - account numbers keep only their last 4 digits (`****0440`), which is what
 *     an auditor needs to tell two accounts apart
 *   - tokens, secrets, passwords and OTP codes are replaced outright
 *   - a CSV body is replaced by its size: the file went to the bank, the log
 *     records that it was produced, the rows record what was in it
 */

const MASK_KEYS = new Set(["accountnumber", "account_number", "bankaccount"]);
const DROP_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "token",
  "password",
  "secret",
  "devcode",
  "otp",
  "otpcode",
]);
const SIZE_KEYS = new Set(["csv"]);
/**
 * Keys that only *sometimes* hold an account number — the payout-file rows
 * carry it as `account`, while ledger code uses `account` for an account
 * object or a ledger name. Masked only when the value is a run of digits.
 */
const MAYBE_ACCOUNT_KEYS = new Set(["account", "beneficiaryaccount", "payee_account"]);
const ACCOUNT_LIKE = /^[\d\s-]{6,}$/;

export function maskAccountNumber(value: string): string {
  const digits = value.replace(/\s+/g, "");
  return digits.length <= 4 ? "****" : `****${digits.slice(-4)}`;
}

export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > 10 || value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => redactForAudit(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (MASK_KEYS.has(key) && typeof v === "string") out[k] = maskAccountNumber(v);
    else if (MAYBE_ACCOUNT_KEYS.has(key) && typeof v === "string" && ACCOUNT_LIKE.test(v)) out[k] = maskAccountNumber(v.replace(/-/g, ""));
    else if (DROP_KEYS.has(key) && v !== null && v !== undefined) out[k] = "[redacted]";
    else if (SIZE_KEYS.has(key) && typeof v === "string") out[k] = `[${v.length} bytes]`;
    else out[k] = redactForAudit(v, depth + 1);
  }
  return out;
}
