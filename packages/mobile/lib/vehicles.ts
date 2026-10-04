/**
 * Linehaul vehicle vocabulary (Round 6) — mirrors packages/web/src/web/lib/vehicles.ts.
 * The server's zod enums are the source of truth.
 */

export const VEHICLE_TYPES = [
  { value: "bus", label: "Bus" },
  { value: "van", label: "Van" },
  { value: "lorry", label: "Lorry" },
  { value: "car", label: "Car" },
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number]["value"];

export const BUS_OPERATORS = [
  { value: "ctb", label: "CTB" },
  { value: "private", label: "Private" },
  { value: "ac_bus", label: "AC bus" },
] as const;
export type BusOperator = (typeof BUS_OPERATORS)[number]["value"];

export function vehicleLabel(type: string | null | undefined, operator?: string | null): string {
  if (!type) return "";
  const t = VEHICLE_TYPES.find((v) => v.value === type)?.label ?? type;
  const o = operator ? (BUS_OPERATORS.find((v) => v.value === operator)?.label ?? operator) : null;
  return o ? `${t} · ${o}` : t;
}

export function isLkPhone(input: string): boolean {
  return /^(?:\+94|94|0)\d{9}$/.test(input.replace(/[^\d+]/g, ""));
}

/**
 * "HH:MM" typed on the phone → the next time that clock reading comes round in
 * Asia/Colombo (fixed +05:30, no DST): later today, or tomorrow if it has passed.
 */
export function nextColomboTime(hhmm: string, now: Date = new Date()): Date | null {
  const m = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return null;
  const offset = 330 * 60_000;
  const local = new Date(now.getTime() + offset);
  const candidate = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    Number(m[1]),
    Number(m[2]),
  ) - offset;
  return new Date(candidate > now.getTime() ? candidate : candidate + 24 * 3_600_000);
}
