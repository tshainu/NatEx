const EMPLOYEE_NUMBER_PREFIX = "N26";
const FIRST_EMPLOYEE_NUMBER = 2n;

/** Return the next automatic code, preserving existing and legacy employee numbers. */
export function nextEmployeeCode(existingCodes: readonly string[]): string {
  let highest = FIRST_EMPLOYEE_NUMBER - 1n;
  for (const code of existingCodes) {
    const match = new RegExp(`^${EMPLOYEE_NUMBER_PREFIX}(\\d+)$`, "i").exec(code.trim());
    if (!match) continue;
    const sequence = BigInt(match[1]!);
    if (sequence > highest) highest = sequence;
  }

  const next = highest + 1n;
  const code = `${EMPLOYEE_NUMBER_PREFIX}${next.toString().padStart(3, "0")}`;
  if (code.length > 20) throw new RangeError("The automatic employee number sequence is exhausted.");
  return code;
}
