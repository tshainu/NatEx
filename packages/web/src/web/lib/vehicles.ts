/**
 * Linehaul vehicle vocabulary (Round 6). The server's zod enums in
 * `api/routes/transport.ts` are the source of truth; these are the labels.
 * Mirrored in `packages/mobile/lib/vehicles.ts`.
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
  if (!type) return "—";
  const t = VEHICLE_TYPES.find((v) => v.value === type)?.label ?? type;
  const o = operator ? BUS_OPERATORS.find((v) => v.value === operator)?.label ?? operator : null;
  return o ? `${t} · ${o}` : t;
}

/** 07X XXX XXXX / +94 7X XXX XXXX → valid Sri Lankan number? */
export function isLkPhone(input: string): boolean {
  const d = input.replace(/[^\d+]/g, "");
  return /^(?:\+94|94|0)\d{9}$/.test(d);
}
