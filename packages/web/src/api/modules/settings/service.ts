/**
 * MODULE: settings — the ONLY reader of settings_value (§4).
 *
 * §10 M5: "SLA & business rule configuration" and "session policy". Every
 * value is an integer with a unit, a range, a reason it has the value it has,
 * and who last changed it — the same shape as the money module's
 * cod_finance_config, which stays separate so a fee has exactly one home.
 *
 * Consumers (delivery, collection, sync, identity) call `settingValue()`; the
 * value is cached (30 s TTL) and the cache cleared on write, so an edit applies
 * to the next request without a restart.
 */

import { db } from "../../database";
import { settingValue as settingTable } from "../../database/schema/settings";
import { MAX_DELIVERY_ATTEMPTS } from "../parcels/state-machine";

export const SETTING_KEYS = {
  NDR_SLA_HOURS: "ndr_sla_hours",
  PICKUP_HORIZON_DAYS: "pickup_horizon_days",
  DELIVERY_OTP_TTL_MINUTES: "delivery_otp_ttl_minutes",
  CLOCK_SKEW_ALERT_MINUTES: "clock_skew_alert_minutes",
  SESSION_IDLE_MINUTES: "session_idle_minutes",
  SESSION_MAX_DAYS: "session_max_days",
  MFA_ENFORCED: "mfa_enforced",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export type SettingGroup = "sla" | "business" | "session";

interface SettingSpec {
  key: SettingKey;
  group: SettingGroup;
  label: string;
  unit: "hours" | "days" | "minutes" | "boolean";
  value: number;
  min: number;
  max: number;
  description: string;
  note: string;
}

export const SETTING_SPECS: SettingSpec[] = [
  {
    key: SETTING_KEYS.NDR_SLA_HOURS,
    group: "sla",
    label: "NDR response SLA",
    unit: "hours",
    value: 24,
    min: 1,
    max: 168,
    description: "Hours a merchant has to answer a non-delivery report before ops may act for them",
    note: "§8 NDR queue. 24 h was the M3 default; applies to NDRs raised after the change — an open NDR keeps the clock it was given.",
  },
  {
    key: SETTING_KEYS.PICKUP_HORIZON_DAYS,
    group: "business",
    label: "Pickup booking horizon",
    unit: "days",
    value: 14,
    min: 1,
    max: 60,
    description: "How far ahead a merchant may book a pickup",
    note: "M3 default. Not specified in PROJECT.md.",
  },
  {
    key: SETTING_KEYS.DELIVERY_OTP_TTL_MINUTES,
    group: "business",
    label: "Doorstep OTP validity",
    unit: "minutes",
    value: 15,
    min: 5,
    max: 120,
    description: "Minutes a consignee's delivery code stays valid",
    note: "M3 default for OTP proof-of-delivery (§15 q7 POD policy is per merchant).",
  },
  {
    key: SETTING_KEYS.CLOCK_SKEW_ALERT_MINUTES,
    group: "business",
    label: "Device clock-skew alert",
    unit: "minutes",
    value: 30,
    min: 1,
    max: 1440,
    description: "Clock difference at which a syncing device is flagged as untrustworthy",
    note: "§7 offline sync. Device time is evidence of when a scan happened; past this skew ops are told not to trust it.",
  },
  {
    key: SETTING_KEYS.SESSION_IDLE_MINUTES,
    group: "session",
    label: "Portal idle timeout",
    unit: "minutes",
    value: 720,
    min: 30,
    max: 10_080,
    description: "A portal session (ops, admin, finance, merchant) not refreshed for this long must sign in again",
    note: "12 h — a full shift. Minimum 30: the 15-minute access token must be able to refresh at least once. Riders and transport are EXEMPT: their apps are offline-first (§7) and must never be signed out mid-route without signal.",
  },
  {
    key: SETTING_KEYS.SESSION_MAX_DAYS,
    group: "session",
    label: "Absolute session lifetime",
    unit: "days",
    value: 30,
    min: 1,
    max: 90,
    description: "Days after sign-in that any session ends, however often it is refreshed",
    note: "§13 JWT_REFRESH_TTL=30d. Applies to every role, riders included.",
  },
  {
    key: SETTING_KEYS.MFA_ENFORCED,
    group: "session",
    label: "Require TOTP for ops, admin and finance",
    unit: "boolean",
    value: 1,
    min: 0,
    max: 1,
    description: "Ops, admin and finance sign in with phone OTP plus an authenticator code",
    note: "§2: TOTP MFA for ops/admin/finance. ON by default. Switching it off is audited and is a policy exception, not a setting to leave off.",
  },
];

const DEFAULTS = new Map<string, number>(SETTING_SPECS.map((s) => [s.key, s.value]));

/**
 * Cached per process for CACHE_TTL_MS. The writing process clears it at once;
 * any other instance (or a script that wrote directly) converges within the TTL.
 * The auth guard reads `mfa_enforced` on every request, hence the cache.
 */
const CACHE_TTL_MS = 30_000;
let cache: { map: Map<string, number>; at: number } | null = null;

export function clearSettingsCache(): void {
  cache = null;
}

async function load(): Promise<Map<string, number>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;
  const rows = await db.select().from(settingTable);
  const map = new Map(DEFAULTS);
  for (const row of rows) map.set(row.key, row.value);
  cache = { map, at: Date.now() };
  return map;
}

export async function settingValue(key: SettingKey): Promise<number> {
  return (await load()).get(key) ?? DEFAULTS.get(key) ?? 0;
}

export async function settingFlag(key: SettingKey): Promise<boolean> {
  return (await settingValue(key)) === 1;
}

export function specOf(key: SettingKey): SettingSpec {
  return SETTING_SPECS.find((s) => s.key === key)!;
}

/** Why a value is refused, or null. */
export function settingProblem(key: SettingKey, value: number): string | null {
  const spec = specOf(key);
  if (!Number.isInteger(value)) return "Must be a whole number.";
  if (spec.unit === "boolean" && value !== 0 && value !== 1) return "A switch is 0 (off) or 1 (on).";
  if (value < spec.min || value > spec.max) return `Must be between ${spec.min} and ${spec.max} ${spec.unit}.`;
  return null;
}

export interface SettingView {
  key: SettingKey | "max_delivery_attempts";
  group: SettingGroup;
  label: string;
  unit: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  description: string;
  note: string | null;
  editable: boolean;
  updatedAt: Date | null;
  updatedByName: string | null;
}

export async function listSettings(): Promise<SettingView[]> {
  const rows = await db.select().from(settingTable);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: SettingView[] = SETTING_SPECS.map((s) => {
    const row = byKey.get(s.key);
    return {
      key: s.key,
      group: s.group,
      label: s.label,
      unit: s.unit,
      value: row?.value ?? s.value,
      defaultValue: s.value,
      min: s.min,
      max: s.max,
      description: s.description,
      note: row?.note ?? s.note,
      editable: true,
      updatedAt: row?.updatedAt ?? null,
      updatedByName: row?.updatedByName ?? null,
    };
  });
  // Shown, never editable: §6 fixes it and the state machine's auto-RTO rule
  // is a pure function of it. Changing it is a code change with tests.
  out.push({
    key: "max_delivery_attempts",
    group: "sla",
    label: "Delivery attempts before RTO",
    unit: "count",
    value: MAX_DELIVERY_ATTEMPTS,
    defaultValue: MAX_DELIVERY_ATTEMPTS,
    min: MAX_DELIVERY_ATTEMPTS,
    max: MAX_DELIVERY_ATTEMPTS,
    description: "Failed attempts after which a parcel is returned to origin automatically",
    note: "Fixed by PROJECT.md §5/§6 (\"Max 3 attempts, then RTO\"). Part of the parcel state machine, not configuration.",
    editable: false,
    updatedAt: null,
    updatedByName: null,
  });
  return out;
}

export async function setSetting(input: {
  key: SettingKey;
  value: number;
  note?: string | null;
  actorName: string;
}): Promise<{ before: number; after: number }> {
  const before = await settingValue(input.key);
  const now = new Date();
  await db
    .insert(settingTable)
    .values({
      key: input.key,
      value: input.value,
      note: input.note ?? specOf(input.key).note,
      updatedAt: now,
      updatedByName: input.actorName,
    })
    .onConflictDoUpdate({
      target: settingTable.key,
      set: {
        value: input.value,
        note: input.note ?? specOf(input.key).note,
        updatedAt: now,
        updatedByName: input.actorName,
      },
    });
  clearSettingsCache();
  return { before, after: input.value };
}
