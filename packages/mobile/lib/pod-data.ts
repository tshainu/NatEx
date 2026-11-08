/** Validate an entered Sri Lankan NIC without exposing the full value to callers. */
export function receiverNicLast4(input: string): string | null {
  const nic = input.trim().toUpperCase();
  if (/^\d{12}$/.test(nic)) return nic.slice(-4);
  if (/^\d{9}[VX]$/.test(nic)) return nic.slice(5, 9);
  return null;
}
