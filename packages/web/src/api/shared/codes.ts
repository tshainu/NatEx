/**
 * Human-readable document codes (DSP261002-7KQ3XM, STL261002-…, RS261002-…).
 *
 * These used to end in 4 random digits: 9 000 codes per prefix per day, so two
 * documents minted the same day collided on the UNIQUE `code` index often
 * enough to surface as a 500 in a UI run (`disputes.open`, 2026-10-02). Now:
 *   - the suffix is 6 characters of Crockford base32 from the CSPRNG
 *     (~1.07e9 per prefix per day; no I, L, O or U, so it reads aloud cleanly)
 *   - every insert goes through `insertWithFreshCode`, which re-mints on a
 *     UNIQUE violation of that table's `code` column instead of failing.
 * A collision therefore costs one extra INSERT, never a refused request.
 */

import { isUniqueViolationOn } from "./errors";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_SUFFIX_LENGTH = 6;

/** `${prefix}${yymmdd}-${6 × base32}` for an ISO day (YYYY-MM-DD). */
export function mintDocumentCode(prefix: string, isoDay: string): string {
  const compact = isoDay.replaceAll("-", "").slice(2);
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_SUFFIX_LENGTH));
  let suffix = "";
  for (const b of bytes) suffix += CROCKFORD[b & 31];
  return `${prefix}${compact}-${suffix}`;
}

/**
 * Run `insert(code)` with a freshly minted code, re-minting on a UNIQUE
 * violation of `${table}.code`. Any other error propagates untouched. Returns
 * the code that landed together with the insert's own result.
 */
export async function insertWithFreshCode<T>(
  table: string,
  mint: () => string,
  insert: (code: string) => Promise<T>,
  attempts = 5,
): Promise<{ code: string; result: T }> {
  for (let attempt = 1; ; attempt++) {
    const code = mint();
    try {
      return { code, result: await insert(code) };
    } catch (error) {
      if (attempt >= attempts || !isUniqueViolationOn(error, `${table}.code`)) throw error;
    }
  }
}
