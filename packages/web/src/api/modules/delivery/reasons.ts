import { asc, count, eq } from "drizzle-orm";
import { db } from "../../database";
import { reasonCode } from "../../database/schema/delivery";
import { errors } from "../../shared/errors";

/**
 * Failure reason codes (PROJECT.md §10 M3 "failure reason codes").
 *
 * Part of the delivery module — `delivery_reason_code` is only ever read here
 * and through this file's exports (§4).
 *
 * The three flags carry the business rules:
 *
 *   countsAsAttempt  — does this failure burn one of §6's three attempts?
 *                      A flood, a curfew or a van breakdown is NatEx's failure,
 *                      not the consignee's, so it must not.
 *   allowsReattempt  — may the parcel go out again on its own, or does it need
 *                      a merchant instruction first? A wrong address cannot be
 *                      fixed by driving there again.
 *   triggersRto      — does the parcel turn back immediately, skipping the NDR
 *                      wait? A refusal is final; there is nothing to instruct.
 *
 * Rows live in a table rather than an enum in code because §10 M5 hands their
 * editing to the admin portal, and because ops must be able to retune the flags
 * without a deploy.
 */

export type ReasonCodeRow = typeof reasonCode.$inferSelect;

type Seed = {
  code: string;
  label: string;
  category: "consignee" | "address" | "payment" | "parcel" | "courier";
  countsAsAttempt?: boolean;
  allowsReattempt?: boolean;
  triggersRto?: boolean;
  notifyConsignee?: boolean;
  sortOrder: number;
};

/**
 * The starting set, drawn from what actually stops a delivery in Sri Lanka.
 * Defaults are countsAsAttempt = true, allowsReattempt = true,
 * triggersRto = false, notifyConsignee = true — so only the exceptions are
 * spelled out below, and each one that deviates says why.
 */
export const DEFAULT_REASON_CODES: readonly Seed[] = [
  // -- consignee ----------------------------------------------------------
  { code: "CONSIGNEE_UNREACHABLE", label: "Phone not answered / switched off", category: "consignee", sortOrder: 10 },
  { code: "CONSIGNEE_NOT_AT_HOME", label: "Nobody at the address", category: "consignee", sortOrder: 20 },
  { code: "PREMISES_CLOSED", label: "Shop or office closed", category: "consignee", sortOrder: 30 },
  {
    code: "RESCHEDULE_REQUESTED",
    label: "Consignee asked for another day",
    category: "consignee",
    sortOrder: 40,
  },
  {
    code: "CONSIGNEE_REFUSED",
    label: "Consignee refused the parcel",
    category: "consignee",
    // A refusal is final: there is nothing for the merchant to instruct, so the
    // parcel turns back on the spot rather than waiting out an NDR clock.
    allowsReattempt: false,
    triggersRto: true,
    sortOrder: 50,
  },
  // -- address ------------------------------------------------------------
  {
    code: "ADDRESS_INCOMPLETE",
    label: "Address incomplete or unreadable",
    category: "address",
    // Driving to the same bad address again is not a delivery attempt strategy.
    allowsReattempt: false,
    sortOrder: 60,
  },
  {
    code: "ADDRESS_NOT_FOUND",
    label: "Address could not be located",
    category: "address",
    allowsReattempt: false,
    sortOrder: 70,
  },
  {
    code: "CONSIGNEE_MOVED",
    label: "Consignee has moved away",
    category: "address",
    allowsReattempt: false,
    sortOrder: 80,
  },
  {
    code: "OUTSIDE_SERVICE_AREA",
    label: "Address outside the served zone",
    category: "address",
    // NatEx cannot serve it at any attempt count — send it straight back.
    allowsReattempt: false,
    triggersRto: true,
    sortOrder: 90,
  },
  // -- payment ------------------------------------------------------------
  { code: "COD_NOT_READY", label: "COD cash not ready", category: "payment", sortOrder: 100 },
  {
    code: "COD_AMOUNT_DISPUTED",
    label: "Consignee disputes the COD amount",
    category: "payment",
    // Only the merchant can settle the figure; a reattempt would fail the same way.
    allowsReattempt: false,
    sortOrder: 110,
  },
  // -- parcel -------------------------------------------------------------
  {
    code: "PARCEL_DAMAGED",
    label: "Parcel damaged, not handed over",
    category: "parcel",
    allowsReattempt: false,
    sortOrder: 120,
  },
  {
    code: "WRONG_PARCEL_IN_HAND",
    label: "Label and contents do not match",
    category: "parcel",
    // NatEx's mistake: it must not cost the consignee an attempt.
    countsAsAttempt: false,
    notifyConsignee: false,
    sortOrder: 130,
  },
  // -- courier (NatEx's own failures — never count as an attempt) ---------
  {
    code: "VEHICLE_BREAKDOWN",
    label: "Vehicle breakdown",
    category: "courier",
    countsAsAttempt: false,
    notifyConsignee: false,
    sortOrder: 140,
  },
  {
    code: "TIME_EXHAUSTED",
    label: "Ran out of time on the run",
    category: "courier",
    countsAsAttempt: false,
    notifyConsignee: false,
    sortOrder: 150,
  },
  {
    code: "MISROUTED",
    label: "Parcel sent to the wrong hub",
    category: "courier",
    countsAsAttempt: false,
    notifyConsignee: false,
    sortOrder: 160,
  },
  {
    code: "WEATHER_FLOOD",
    label: "Flood or severe weather",
    category: "courier",
    countsAsAttempt: false,
    // Worth telling the consignee — they are standing in the same flood.
    sortOrder: 170,
  },
  {
    code: "CURFEW_UNREST",
    label: "Curfew or civil unrest",
    category: "courier",
    countsAsAttempt: false,
    sortOrder: 180,
  },
];

/** Idempotent: inserts only the codes that are missing. Returns how many. */
export async function seedReasonCodes(): Promise<number> {
  let inserted = 0;
  for (const seed of DEFAULT_REASON_CODES) {
    const [existing] = await db
      .select({ code: reasonCode.code })
      .from(reasonCode)
      .where(eq(reasonCode.code, seed.code));
    if (existing) continue;
    await db.insert(reasonCode).values({
      code: seed.code,
      label: seed.label,
      category: seed.category,
      countsAsAttempt: seed.countsAsAttempt ?? true,
      allowsReattempt: seed.allowsReattempt ?? true,
      triggersRto: seed.triggersRto ?? false,
      notifyConsignee: seed.notifyConsignee ?? true,
      sortOrder: seed.sortOrder,
      active: true,
    });
    inserted += 1;
  }
  return inserted;
}

export async function listReasonCodes(includeInactive = false): Promise<ReasonCodeRow[]> {
  const rows = await db
    .select()
    .from(reasonCode)
    .orderBy(asc(reasonCode.category), asc(reasonCode.sortOrder));
  return includeInactive ? rows : rows.filter((r) => r.active);
}

/** Throws 422 rather than 404 — a bad reason code is invalid input, not a missing page. */
export async function requireReasonCode(code: string): Promise<ReasonCodeRow> {
  const [row] = await db.select().from(reasonCode).where(eq(reasonCode.code, code));
  if (!row) {
    const known = await listReasonCodes();
    errors.badRequest(`Unknown failure reason code "${code}".`, {
      knownCodes: known.map((r) => r.code),
    });
  }
  if (!row!.active) {
    errors.badRequest(`Reason code "${code}" is retired and may not be used.`);
  }
  return row!;
}

export async function reasonCodeCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(reasonCode);
  return row?.value ?? 0;
}
