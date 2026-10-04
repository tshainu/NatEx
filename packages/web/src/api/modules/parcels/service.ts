import { and, asc, count, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "../../database";
import { parcel, parcelEvent } from "../../database/schema/parcels";
import { prefixedId } from "../../shared/ulid";
import { errors } from "../../shared/errors";
import { enqueue } from "../../shared/outbox";
import { isGlobalScope, type Principal } from "../../shared/auth";
import { getMerchant } from "../merchants/service";
import { addDays, colomboToday as colomboDate } from "../../shared/time";
import {
  isEnabled,
  isLegalTransition,
  isTerminal,
  legalNext,
  locksCod,
  milestoneFor,
  requiresPod,
  requiresSealedBag,
  roleMayCommand,
  TRANSITION_ROLES,
  TERMINAL_STATUSES as TERMINAL_LIST,
  type ParcelStatus,
} from "./state-machine";

/**
 * MODULE: parcels. The ONLY file that reads parcels_* tables (PROJECT.md §4).
 * Other modules call these functions; they never SELECT these tables.
 *
 * NON-NEGOTIABLE (§1, §6): a parcel's status is never written without a paired
 * parcel_event row. `transitionParcel()` below is the single choke point that
 * writes both. No other function in this codebase updates parcel.status.
 */

export type ParcelRow = typeof parcel.$inferSelect;
export type ParcelEventRow = typeof parcelEvent.$inferSelect;

// ---------------------------------------------------------------- AWB minting

/**
 * AWB is the parcel's public identity (§5): stable, human-readable, printed on
 * the label, read out over the phone. Never the internal id.
 */
function mintAwb(): string {
  let digits = "";
  for (let i = 0; i < 10; i++) digits += Math.floor(Math.random() * 10).toString();
  return `NX${digits}`;
}

async function uniqueAwb(): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = mintAwb();
    const [clash] = await db
      .select({ id: parcel.id })
      .from(parcel)
      .where(eq(parcel.awb, candidate));
    if (!clash) return candidate;
  }
  // `return` only to tell the compiler the function ends here: every `errors.*`
  // helper throws (its return type is `never`).
  return errors.conflict("Could not mint a unique AWB. Retry.");
}

// ------------------------------------------------------------- event appending

interface EventInput {
  parcelId: string;
  fromStatus: ParcelStatus | null;
  toStatus: ParcelStatus;
  actor?: Principal | null;
  lat?: number | null;
  lng?: number | null;
  notes?: string | null;
  clientId?: string | null;
}

/**
 * The only writer of parcels_parcel_event, anywhere. Append-only: this function
 * inserts and nothing in this codebase updates or deletes the row.
 */
async function appendParcelEvent(input: EventInput): Promise<ParcelEventRow> {
  const [row] = await db
    .insert(parcelEvent)
    .values({
      id: prefixedId("pev"),
      parcelId: input.parcelId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      actorId: input.actor?.userId ?? null,
      actorName: input.actor?.name ?? null,
      actorRole: input.actor?.role ?? null,
      deviceId: input.actor?.deviceId ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      notes: input.notes ?? null,
      clientId: input.clientId ?? null,
      ts: new Date(),
    })
    .returning();
  return row!;
}

// ------------------------------------------------------------------ read paths

function scopeFilter(scope: Principal) {
  if (isGlobalScope(scope.role)) return undefined;
  if (scope.role === "merchant") {
    // A merchant sees only its own parcels (§5 row-level scoping).
    return eq(parcel.merchantId, scope.merchantId ?? "__none__");
  }
  return eq(parcel.branchId, scope.branchId);
}

/** Assert the caller is allowed to see this parcel at all. */
function assertVisible(row: ParcelRow, scope: Principal): void {
  if (isGlobalScope(scope.role)) return;
  if (scope.role === "merchant") {
    if (row.merchantId !== scope.merchantId) errors.notFound("Parcel");
    return;
  }
  if (row.branchId !== scope.branchId) {
    errors.forbidden("This parcel belongs to another branch.", {
      parcelBranchId: row.branchId,
    });
  }
}

export async function getParcelById(id: string): Promise<ParcelRow | null> {
  const [row] = await db.select().from(parcel).where(eq(parcel.id, id));
  return row ?? null;
}

export async function getParcelByAwb(awb: string): Promise<ParcelRow | null> {
  const [row] = await db.select().from(parcel).where(eq(parcel.awb, awb.trim().toUpperCase()));
  return row ?? null;
}

export interface ParcelDetail {
  parcel: ParcelRow;
  timeline: ParcelEventRow[];
  legalNext: readonly ParcelStatus[];
  /** Of `legalNext`, the ones this caller's role may command in M1. */
  commandable: ParcelStatus[];
}

/**
 * Whether the generic status command (parcels.transition / the drawer's buttons)
 * can carry this edge for this role. Edges that need evidence — a POD for
 * Delivered/RTODelivered, a sealed bag on a departing trip for Bagged → InTransit
 * (§6) — are legal and the role may hold them, but only the workflow that
 * produces the evidence (delivery.recordDelivery, ndr RTO deliver, transport
 * tripDepart) can make them. Offering them as a button would only ever 422.
 */
export function isGenericallyCommandable(
  from: ParcelStatus,
  to: ParcelStatus,
  role: Principal["role"],
): boolean {
  return (
    isEnabled(to) &&
    roleMayCommand(role, to) &&
    !requiresPod(to) &&
    !requiresSealedBag(from, to)
  );
}

export async function getParcelDetail(
  awbOrId: string,
  scope: Principal,
): Promise<ParcelDetail> {
  const row =
    (await getParcelByAwb(awbOrId)) ?? (await getParcelById(awbOrId));
  if (!row) errors.notFound("Parcel");
  assertVisible(row!, scope);

  const timeline = await db
    .select()
    .from(parcelEvent)
    .where(eq(parcelEvent.parcelId, row!.id))
    .orderBy(asc(parcelEvent.ts));

  const next = legalNext(row!.status as ParcelStatus);
  return {
    parcel: row!,
    timeline,
    legalNext: next,
    commandable: next.filter((to) =>
      isGenericallyCommandable(row!.status as ParcelStatus, to, scope.role),
    ),
  };
}

/**
 * The consignee-facing view of a parcel (§10 M2, `/track/:awb`).
 *
 * PDPA No. 9 of 2022 purpose limitation (§9): the caller is unauthenticated, so
 * this returns only what a consignee needs to locate their own parcel. Every
 * field of personal data beyond the destination town — name, phone, full
 * address — and every commercial field — COD, declared value, merchant — is
 * withheld here and is reachable only through the staff-scoped read paths.
 *
 * The timeline is reduced to status + timestamp: no actor names, no device
 * ids, no GPS. Statuses are mapped to public wording so internal vocabulary
 * ("AtOriginHub") does not leak operational structure.
 */
export interface PublicTracking {
  awb: string;
  status: ParcelStatus;
  publicStatus: string;
  /** Best-effort destination locality, derived from the address, not the raw line. */
  destinationArea: string;
  attempts: number;
  bookedAt: Date;
  lastUpdatedAt: Date;
  timeline: { status: ParcelStatus; label: string; ts: Date }[];
}

/** Consignee-facing wording for each internal status (§6 enum → plain English). */
const PUBLIC_STATUS_LABELS: Record<ParcelStatus, string> = {
  Booked: "Booking received",
  PickedUp: "Collected from sender",
  AtOriginHub: "At origin facility",
  Bagged: "Prepared for transport",
  InTransit: "In transit",
  AtDestHub: "Arrived at delivery facility",
  OutForDelivery: "Out for delivery",
  Delivered: "Delivered",
  DeliveryAttempted: "Delivery attempted",
  OnHold: "On hold",
  RTOInitiated: "Return to sender started",
  RTOInTransit: "Returning to sender",
  RTODelivered: "Returned to sender",
  Lost: "Under investigation",
  Damaged: "Under investigation",
  Cancelled: "Cancelled",
  ReturnedToMerchant: "Returned to sender",
};

export function publicStatusLabel(status: ParcelStatus): string {
  return PUBLIC_STATUS_LABELS[status] ?? "In progress";
}

/**
 * Reduce a street address to a locality for public display. Sri Lankan
 * addresses put the town last, so the trailing comma-separated part is the
 * closest thing to a town without a geocoder round-trip (§5: never re-geocode).
 */
function localityOf(address: string): string {
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  // Strip a house/street number prefix if the last part is itself a street line.
  return last.replace(/^\d+[/\d]*\s+/, "") || "Sri Lanka";
}

export async function publicTracking(awb: string): Promise<PublicTracking | null> {
  const row = await getParcelByAwb(awb);
  if (!row) return null;

  const events = await db
    .select({ toStatus: parcelEvent.toStatus, ts: parcelEvent.ts })
    .from(parcelEvent)
    .where(eq(parcelEvent.parcelId, row.id))
    .orderBy(asc(parcelEvent.ts));

  const status = row.status as ParcelStatus;
  return {
    awb: row.awb,
    status,
    publicStatus: publicStatusLabel(status),
    destinationArea: localityOf(row.destAddress),
    attempts: row.deliveryAttempts,
    bookedAt: row.createdAt,
    lastUpdatedAt: row.updatedAt,
    timeline: events.map((e) => ({
      status: e.toStatus as ParcelStatus,
      label: publicStatusLabel(e.toStatus as ParcelStatus),
      ts: e.ts,
    })),
  };
}

export interface ListParcelsInput {
  page: number;
  pageSize: number;
  status?: ParcelStatus[];
  merchantId?: string;
  branchId?: string;
  /** Matches AWB, consignee name or consignee phone. */
  search?: string;
}

export async function listParcels(input: ListParcelsInput, scope: Principal) {
  if (scope.role === "merchant" && input.merchantId && input.merchantId !== scope.merchantId) {
    // §5: a merchant naming another merchant is refused, never silently re-scoped.
    errors.forbidden("A merchant may only read its own parcels.", { merchantId: input.merchantId });
  }
  const filters = [scopeFilter(scope)];

  if (input.status?.length) filters.push(inArray(parcel.status, input.status));
  if (input.merchantId) filters.push(eq(parcel.merchantId, input.merchantId));
  // A branch filter can only narrow, never widen, the caller's own scope.
  if (input.branchId && isGlobalScope(scope.role)) {
    filters.push(eq(parcel.branchId, input.branchId));
  }
  if (input.search?.trim()) {
    const term = `%${input.search.trim()}%`;
    filters.push(
      or(
        like(parcel.awb, term.toUpperCase()),
        like(parcel.consigneeName, term),
        like(parcel.consigneePhone, term),
      ),
    );
  }

  const where = and(...filters.filter((f) => f !== undefined));
  const pageSize = Math.min(Math.max(input.pageSize, 1), 100);
  const offset = (Math.max(input.page, 1) - 1) * pageSize;

  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(parcel)
      .where(where)
      .orderBy(desc(parcel.updatedAt))
      .limit(pageSize)
      .offset(offset),
    db.select({ value: count() }).from(parcel).where(where),
  ]);

  return {
    rows,
    total: total?.value ?? 0,
    page: Math.max(input.page, 1),
    pageSize,
  };
}

/** Status counts for the ops board header. Branch-scoped like everything else. */
export async function statusCounts(scope: Principal) {
  const where = scopeFilter(scope);
  const rows = await db
    .select({ status: parcel.status, value: count() })
    .from(parcel)
    .where(where)
    .groupBy(parcel.status);
  return rows.map((r) => ({ status: r.status as ParcelStatus, count: r.value }));
}

export interface ParcelSummary {
  byStatus: { status: ParcelStatus; count: number }[];
  total: number;
  bookedToday: number;
  /** Not yet delivered, returned or written off. */
  open: number;
  /** COD declared on open parcels — still to be collected. Integer cents. */
  codOpenCents: number;
  last30d: {
    delivered: number;
    /** COD declared on the parcels delivered in the window. Integer cents. */
    deliveredCodCents: number;
    returnsStarted: number;
  };
  generatedAt: string;
}

/**
 * Dashboard numbers, aggregated in SQL under the caller's scope — a merchant
 * gets its own account, ops its branch, admin/finance everything (§5). Never
 * computed in the browser from a page of rows.
 */
export async function parcelSummary(scope: Principal, now: Date = new Date()): Promise<ParcelSummary> {
  const where = scopeFilter(scope);
  const dayStart = new Date(`${colomboDate(now)}T00:00:00+05:30`);
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const terminal = TERMINAL_LIST as unknown as string[];

  const [byStatus, [today], [open], windowRows] = await Promise.all([
    statusCounts(scope),
    db
      .select({ value: count() })
      .from(parcel)
      .where(and(where, sql`${parcel.createdAt} >= ${Math.floor(dayStart.getTime() / 1000)}`)),
    db
      .select({
        value: count(),
        cod: sql<number>`coalesce(sum(${parcel.codAmountCents}), 0)`,
      })
      .from(parcel)
      .where(and(where, sql`${parcel.status} not in (${sql.join(terminal.map((t) => sql`${t}`), sql`, `)})`)),
    db
      .select({
        toStatus: parcelEvent.toStatus,
        value: sql<number>`count(distinct ${parcel.id})`,
        cod: sql<number>`coalesce(sum(${parcel.codAmountCents}), 0)`,
      })
      .from(parcelEvent)
      .innerJoin(parcel, eq(parcel.id, parcelEvent.parcelId))
      .where(
        and(
          where,
          inArray(parcelEvent.toStatus, ["Delivered", "RTOInitiated"]),
          sql`${parcelEvent.ts} >= ${Math.floor(since.getTime() / 1000)}`,
        ),
      )
      .groupBy(parcelEvent.toStatus),
  ]);
  const delivered = windowRows.find((r) => r.toStatus === "Delivered");
  const rto = windowRows.find((r) => r.toStatus === "RTOInitiated");

  return {
    byStatus,
    total: byStatus.reduce((n, r) => n + r.count, 0),
    bookedToday: today?.value ?? 0,
    open: open?.value ?? 0,
    codOpenCents: Number(open?.cod ?? 0),
    last30d: {
      delivered: Number(delivered?.value ?? 0),
      deliveredCodCents: Number(delivered?.cod ?? 0),
      returnsStarted: Number(rto?.value ?? 0),
    },
    generatedAt: now.toISOString(),
  };
}

/** Colombo calendar day of a unix-seconds column, in SQL (fixed +05:30, §9). */
const colomboDay = (column: unknown) => sql<string>`date(${column} + 19800, 'unixepoch')`;

export interface TrendDay {
  /** YYYY-MM-DD, Asia/Colombo. */
  date: string;
  booked: number;
  /** COD declared on the parcels booked that day. Integer cents. */
  bookedCodCents: number;
  delivered: number;
  /** COD declared on the parcels delivered that day. Integer cents. */
  deliveredCodCents: number;
  /** Parcels with a failed delivery attempt that day. */
  attempted: number;
  /** Parcels sent into return-to-origin that day. */
  rto: number;
}

export interface ParcelTrends {
  days: TrendDay[];
  totals: Omit<TrendDay, "date">;
  /**
   * delivered ÷ (delivered + failed attempts) over the window, as a whole
   * percentage — null when the window has neither, rather than a fake 0 %.
   */
  successPct: number | null;
  generatedAt: string;
}

/**
 * Daily throughput for the dashboard charts, aggregated in SQL under the
 * caller's §5 scope. Booked is counted from the parcel's creation; delivered,
 * failed attempts and RTO from the append-only event log (distinct parcels
 * per day, so a retried scan never counts twice). Every day in the window is
 * returned, including empty ones, so a chart never silently skips a day.
 */
export async function parcelTrends(
  scope: Principal,
  days: number,
  now: Date = new Date(),
): Promise<ParcelTrends> {
  const span = Math.min(Math.max(Math.trunc(days), 1), 90);
  const today = colomboDate(now);
  const first = addDays(today, -(span - 1));
  const since = Math.floor(new Date(`${first}T00:00:00+05:30`).getTime() / 1000);
  const where = scopeFilter(scope);

  const [bookedRows, outcomeRows] = await Promise.all([
    db
      .select({
        day: colomboDay(parcel.createdAt),
        value: count(),
        cod: sql<number>`coalesce(sum(${parcel.codAmountCents}), 0)`,
      })
      .from(parcel)
      .where(and(where, sql`${parcel.createdAt} >= ${since}`))
      .groupBy(colomboDay(parcel.createdAt)),
    db
      .select({
        day: colomboDay(parcelEvent.ts),
        toStatus: parcelEvent.toStatus,
        value: sql<number>`count(distinct ${parcel.id})`,
        cod: sql<number>`coalesce(sum(${parcel.codAmountCents}), 0)`,
      })
      .from(parcelEvent)
      .innerJoin(parcel, eq(parcel.id, parcelEvent.parcelId))
      .where(
        and(
          where,
          inArray(parcelEvent.toStatus, ["Delivered", "DeliveryAttempted", "RTOInitiated"]),
          sql`${parcelEvent.ts} >= ${since}`,
        ),
      )
      .groupBy(colomboDay(parcelEvent.ts), parcelEvent.toStatus),
  ]);

  const byDay = new Map<string, TrendDay>();
  for (let i = 0; i < span; i += 1) {
    const date = addDays(first, i);
    byDay.set(date, { date, booked: 0, bookedCodCents: 0, delivered: 0, deliveredCodCents: 0, attempted: 0, rto: 0 });
  }
  for (const row of bookedRows) {
    const day = byDay.get(row.day);
    if (!day) continue;
    day.booked = Number(row.value);
    day.bookedCodCents = Number(row.cod);
  }
  for (const row of outcomeRows) {
    const day = byDay.get(row.day);
    if (!day) continue;
    if (row.toStatus === "Delivered") {
      day.delivered = Number(row.value);
      day.deliveredCodCents = Number(row.cod);
    } else if (row.toStatus === "DeliveryAttempted") day.attempted = Number(row.value);
    else if (row.toStatus === "RTOInitiated") day.rto = Number(row.value);
  }

  const list = [...byDay.values()];
  const totals = list.reduce(
    (t, d) => ({
      booked: t.booked + d.booked,
      bookedCodCents: t.bookedCodCents + d.bookedCodCents,
      delivered: t.delivered + d.delivered,
      deliveredCodCents: t.deliveredCodCents + d.deliveredCodCents,
      attempted: t.attempted + d.attempted,
      rto: t.rto + d.rto,
    }),
    { booked: 0, bookedCodCents: 0, delivered: 0, deliveredCodCents: 0, attempted: 0, rto: 0 },
  );
  const outcomes = totals.delivered + totals.attempted;
  return {
    days: list,
    totals,
    successPct: outcomes === 0 ? null : Math.round((totals.delivered / outcomes) * 100),
    generatedAt: now.toISOString(),
  };
}

/**
 * Network split by accountable branch — the admin dashboard's branch chart.
 * Branch names belong to identity; the caller resolves them.
 */
export async function branchSplit(): Promise<{ branchId: string; open: number; closed: number }[]> {
  const terminal = TERMINAL_LIST as unknown as string[];
  const rows = await db
    .select({
      branchId: parcel.branchId,
      open: sql<number>`sum(case when ${parcel.status} not in (${sql.join(terminal.map((t) => sql`${t}`), sql`, `)}) then 1 else 0 end)`,
      total: count(),
    })
    .from(parcel)
    .groupBy(parcel.branchId);
  return rows.map((r) => ({
    branchId: r.branchId,
    open: Number(r.open ?? 0),
    closed: Number(r.total) - Number(r.open ?? 0),
  }));
}

/**
 * Busiest merchants by parcels booked in the window, with COD declared on
 * them. Merchant names belong to the merchants module; the caller resolves them.
 */
export async function topMerchants(
  days: number,
  limit: number,
  now: Date = new Date(),
): Promise<{ merchantId: string; parcels: number; codCents: number }[]> {
  const first = addDays(colomboDate(now), -(Math.max(days, 1) - 1));
  const since = Math.floor(new Date(`${first}T00:00:00+05:30`).getTime() / 1000);
  const rows = await db
    .select({
      merchantId: parcel.merchantId,
      parcels: count(),
      cod: sql<number>`coalesce(sum(${parcel.codAmountCents}), 0)`,
    })
    .from(parcel)
    .where(sql`${parcel.createdAt} >= ${since}`)
    .groupBy(parcel.merchantId)
    .orderBy(desc(count()))
    .limit(Math.min(Math.max(limit, 1), 20));
  return rows.map((r) => ({ merchantId: r.merchantId, parcels: Number(r.parcels), codCents: Number(r.cod) }));
}

/** Recent custody events across the branch — the ops live feed. */
export async function recentEvents(scope: Principal, limit = 25) {
  const scoped = await db
    .select({ id: parcel.id })
    .from(parcel)
    .where(scopeFilter(scope))
    .limit(500);
  const ids = scoped.map((r) => r.id);
  if (ids.length === 0) return [];

  return db
    .select({
      id: parcelEvent.id,
      parcelId: parcelEvent.parcelId,
      awb: parcel.awb,
      fromStatus: parcelEvent.fromStatus,
      toStatus: parcelEvent.toStatus,
      actorName: parcelEvent.actorName,
      actorRole: parcelEvent.actorRole,
      ts: parcelEvent.ts,
    })
    .from(parcelEvent)
    .innerJoin(parcel, eq(parcel.id, parcelEvent.parcelId))
    .where(inArray(parcelEvent.parcelId, ids))
    .orderBy(desc(parcelEvent.ts))
    .limit(limit);
}

/** Parcels a rider is expected to collect — read by the collection module. */
export async function parcelsByIds(ids: string[]): Promise<ParcelRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(parcel).where(inArray(parcel.id, ids));
}

// ----------------------------------------------------------------- write paths

export interface CreateParcelInput {
  merchantId: string;
  branchId: string;
  weightGrams: number;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  declaredValueCents: number;
  codAmountCents: number;
  originAddress: string;
  originLat?: number | null;
  originLng?: number | null;
  consigneeName: string;
  consigneePhone: string;
  destAddress: string;
  destLat?: number | null;
  destLng?: number | null;
  destZoneId?: string | null;
}

/**
 * Books a parcel. Entry state is always `Booked` and it gets its genesis
 * parcel_event, so every parcel has a complete custody chain from row one.
 */
export async function createParcel(
  input: CreateParcelInput,
  actor: Principal,
): Promise<ParcelDetail> {
  if (!Number.isInteger(input.codAmountCents) || input.codAmountCents < 0) {
    errors.badRequest("COD must be a non-negative integer number of cents.");
  }
  if (!roleMayCommand(actor.role, "Booked")) {
    errors.forbidden(`Role ${actor.role} may not book parcels.`);
  }
  // §5: a merchant principal books for itself only. Refused, never re-scoped —
  // silently swapping the merchantId would hide a client bug or an attack.
  if (actor.role === "merchant" && input.merchantId !== actor.merchantId) {
    errors.forbidden("A merchant may only book parcels for its own account.", {
      merchantId: input.merchantId,
    });
  }
  const owner = await getMerchant(input.merchantId);
  if (!owner) errors.notFound(`Merchant ${input.merchantId}`);
  if (!isGlobalScope(actor.role) && actor.role !== "merchant" && owner!.branchId !== actor.branchId) {
    errors.forbidden("This merchant belongs to another branch.", {
      merchantBranchId: owner!.branchId,
    });
  }
  if (owner!.status !== "active") {
    errors.conflict(`Merchant ${owner!.name} is ${owner!.status} and cannot book parcels.`, {
      merchantStatus: owner!.status,
    });
  }
  if (input.codAmountCents > 0 && !owner!.codEnabled) {
    errors.badRequest(`Merchant ${owner!.name} is not enabled for cash on delivery.`, {
      codAmountCents: input.codAmountCents,
    });
  }

  const awb = await uniqueAwb();
  const now = new Date();
  const [row] = await db
    .insert(parcel)
    .values({
      id: prefixedId("pcl"),
      awb,
      merchantId: input.merchantId,
      branchId: input.branchId,
      status: "Booked",
      weightGrams: input.weightGrams,
      lengthCm: input.lengthCm ?? null,
      widthCm: input.widthCm ?? null,
      heightCm: input.heightCm ?? null,
      declaredValueCents: input.declaredValueCents,
      codAmountCents: input.codAmountCents,
      originAddress: input.originAddress,
      originLat: input.originLat ?? null,
      originLng: input.originLng ?? null,
      consigneeName: input.consigneeName,
      consigneePhone: input.consigneePhone,
      destAddress: input.destAddress,
      destLat: input.destLat ?? null,
      destLng: input.destLng ?? null,
      destZoneId: input.destZoneId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await appendParcelEvent({
    parcelId: row!.id,
    fromStatus: null,
    toStatus: "Booked",
    actor,
    notes: "Parcel booked.",
  });

  // Enqueued, not sent inline (§4: outbox, never a send inside the handler).
  await enqueue("parcel.status_changed", {
    parcelId: row!.id,
    awb: row!.awb,
    from: null,
    to: "Booked",
  });

  return {
    parcel: row!,
    timeline: await db
      .select()
      .from(parcelEvent)
      .where(eq(parcelEvent.parcelId, row!.id))
      .orderBy(asc(parcelEvent.ts)),
    legalNext: legalNext("Booked"),
    commandable: legalNext("Booked").filter((to) =>
      isGenericallyCommandable("Booked", to, actor.role),
    ),
  };
}

export interface TransitionInput {
  /** AWB or internal id. AWB is what scanners produce. */
  awbOrId: string;
  to: ParcelStatus;
  lat?: number | null;
  lng?: number | null;
  notes?: string | null;
  /** Client-minted ULID so an offline replay dedupes (§7). */
  clientId?: string | null;
}

/**
 * Evidence an owning workflow attaches to a guarded transition (§6). Passed as
 * a separate argument, never read from a request or sync payload, so a client
 * cannot claim a POD it never captured by adding a field to its JSON.
 */
export interface TransitionGuards {
  /** Id of the POD row the delivery/RTO workflow wrote first. */
  podId?: string;
  /** Id of the trip whose sealed bags are departing. */
  tripId?: string;
}

export interface TransitionResult {
  parcel: ParcelRow;
  event: ParcelEventRow;
  /** True when this exact clientId event was already recorded. */
  deduped: boolean;
}

/**
 * THE choke point. Every status change in the system goes through here:
 *
 *   1 the parcel must exist and be visible to the caller's branch scope
 *   2 the transition must be in the legal table, else 422 + current state (§6)
 *   3 the caller's role must be permitted to command that transition (§6)
 *   4 the transition must be exposed in this milestone (§10, no scaffolding ahead)
 *   5 status UPDATE and parcel_event INSERT happen together — never one alone
 *   6 downstream work (SMS, projections) is enqueued on the outbox, not sent here
 */
export async function transitionParcel(
  input: TransitionInput,
  actor: Principal,
  guards: TransitionGuards = {},
): Promise<TransitionResult> {
  const row =
    (await getParcelByAwb(input.awbOrId)) ?? (await getParcelById(input.awbOrId));
  if (!row) errors.notFound(`Parcel ${input.awbOrId}`);
  assertVisible(row!, actor);

  const from = row!.status as ParcelStatus;
  const to = input.to;

  // Offline dedupe: the same client-minted event id is never applied twice (§7).
  if (input.clientId) {
    const [seen] = await db
      .select()
      .from(parcelEvent)
      .where(
        and(eq(parcelEvent.clientId, input.clientId), eq(parcelEvent.parcelId, row!.id)),
      );
    if (seen) return { parcel: row!, event: seen, deduped: true };
  }

  if (from === to) {
    errors.conflict(`Parcel ${row!.awb} is already ${to}.`, {
      awb: row!.awb,
      currentStatus: from,
    });
  }

  if (isTerminal(from)) {
    // "Terminal states are immutable — corrections are reversal events, never edits."
    errors.illegalTransition(row!.awb, from, to, []);
  }

  if (!isLegalTransition(from, to)) {
    errors.illegalTransition(row!.awb, from, to, [...legalNext(from)]);
  }

  if (!roleMayCommand(actor.role, to)) {
    errors.forbidden(`Role ${actor.role} may not move a parcel to ${to}.`, {
      awb: row!.awb,
      requiredRoles: [...TRANSITION_ROLES[to]],
      attemptedStatus: to,
    });
  }

  if (!isEnabled(to)) {
    errors.badRequest(
      `Transition to ${to} is not exposed yet — it unlocks in Milestone ${milestoneFor(to)}.`,
      {
        awb: row!.awb,
        currentStatus: from,
        attemptedStatus: to,
        unlocksInMilestone: milestoneFor(to),
      },
    );
  }

  // §6 workflow guards. The generic transition endpoint and the sync
  // "parcel.transition" op never pass guards, so they cannot reach these.
  if (requiresPod(to) && !guards.podId) {
    errors.illegalTransition(row!.awb, from, to, [...legalNext(from)].filter((s) => !requiresPod(s)), {
      reason: "pod-required",
      detail: `${to} requires proof of delivery — use the delivery workflow.`,
    });
  }
  if (requiresSealedBag(from, to) && !guards.tripId) {
    errors.illegalTransition(row!.awb, from, to, [...legalNext(from)].filter((s) => !requiresSealedBag(from, s)), {
      reason: "sealed-bag-required",
      detail: "Bagged → InTransit requires the bag to be sealed and loaded on a departing trip.",
    });
  }

  const now = new Date();
  const [updated] = await db
    .update(parcel)
    .set({
      status: to,
      updatedAt: now,
      // §6: the COD amount is locked the moment a parcel is Delivered.
      codLockedAt: locksCod(to) ? now : row!.codLockedAt,
      // A parcel that leaves the origin branch stays accountable to it until a
      // hub scan moves custody; branch reassignment is M2 (bagging/trips).
      branchId: row!.branchId,
    })
    .where(and(eq(parcel.id, row!.id), eq(parcel.status, from)))
    .returning();

  if (!updated) {
    // Optimistic guard: another request moved the parcel between our read and
    // our write. Better a 409 than a lost custody event.
    errors.conflict(`Parcel ${row!.awb} changed state concurrently. Re-read and retry.`, {
      awb: row!.awb,
    });
  }

  const event = await appendParcelEvent({
    parcelId: row!.id,
    fromStatus: from,
    toStatus: to,
    actor,
    lat: input.lat,
    lng: input.lng,
    notes: input.notes,
    clientId: input.clientId,
  });

  await enqueue("parcel.status_changed", {
    parcelId: row!.id,
    awb: row!.awb,
    from,
    to,
    consigneePhone: row!.consigneePhone,
  });

  return { parcel: updated!, event, deduped: false };
}

/** Used by the collection module's handover: many parcels, one transition. */
export async function transitionMany(
  awbOrIds: string[],
  to: ParcelStatus,
  actor: Principal,
  extra: { lat?: number | null; lng?: number | null; notes?: string | null } = {},
  guards: TransitionGuards = {},
): Promise<{ moved: TransitionResult[]; rejected: { awb: string; reason: string }[] }> {
  const moved: TransitionResult[] = [];
  const rejected: { awb: string; reason: string }[] = [];

  for (const ref of awbOrIds) {
    try {
      moved.push(await transitionParcel({ awbOrId: ref, to, ...extra }, actor, guards));
    } catch (err) {
      rejected.push({
        awb: ref,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
  return { moved, rejected };
}

/**
 * Resolve scanned AWBs to parcel rows. Returns both what matched and what did
 * not, because an unknown label at a hub is itself an operational event the
 * transport module has to record rather than discard.
 */
export async function resolveAwbs(
  awbs: string[],
): Promise<{ found: ParcelRow[]; unknown: string[] }> {
  const wanted = [...new Set(awbs.map((a) => a.trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return { found: [], unknown: [] };
  const found = await db.select().from(parcel).where(inArray(parcel.awb, wanted));
  const seen = new Set(found.map((r) => r.awb));
  return { found, unknown: wanted.filter((a) => !seen.has(a)) };
}

/**
 * Move accountability for a parcel to another branch, with a custody event.
 *
 * Called by the transport module when a bag is received at the destination hub:
 * until that scan the origin branch stays accountable (§5 row-level scoping is
 * an accountability model, not just a filter). This does NOT change status —
 * the status transition is a separate call through transitionParcel, so the
 * two facts are never conflated in one silent write.
 */
export async function reassignBranch(
  parcelIds: string[],
  branchId: string,
  actor: Principal,
  notes: string,
): Promise<number> {
  let moved = 0;
  for (const id of parcelIds) {
    const row = await getParcelById(id);
    if (!row || row.branchId === branchId) continue;
    await db
      .update(parcel)
      .set({ branchId, updatedAt: new Date() })
      .where(eq(parcel.id, id));
    await appendParcelEvent({
      parcelId: id,
      fromStatus: row.status as ParcelStatus,
      toStatus: row.status as ParcelStatus,
      actor,
      notes: `${notes} Accountability moved from ${row.branchId} to ${branchId}.`,
    });
    moved += 1;
  }
  return moved;
}

/** Parcels in a given set of statuses at a branch — the hub/bagging work queue. */
export async function parcelsAwaiting(
  statuses: ParcelStatus[],
  scope: Principal,
  limit = 200,
): Promise<ParcelRow[]> {
  const filters = [inArray(parcel.status, statuses), scopeFilter(scope)].filter(
    (f) => f !== undefined,
  );
  return db
    .select()
    .from(parcel)
    .where(and(...filters))
    .orderBy(asc(parcel.updatedAt))
    .limit(limit);
}

/** Dev/seed helper — inserts a parcel already in a given state with its chain. */
export async function seedParcel(
  input: CreateParcelInput & { awb: string; status: ParcelStatus },
  chain: { status: ParcelStatus; actorName: string; actorRole: string; at: Date }[],
) {
  const [row] = await db
    .insert(parcel)
    .values({
      id: prefixedId("pcl"),
      awb: input.awb,
      merchantId: input.merchantId,
      branchId: input.branchId,
      status: input.status,
      weightGrams: input.weightGrams,
      lengthCm: input.lengthCm ?? null,
      widthCm: input.widthCm ?? null,
      heightCm: input.heightCm ?? null,
      declaredValueCents: input.declaredValueCents,
      codAmountCents: input.codAmountCents,
      originAddress: input.originAddress,
      originLat: input.originLat ?? null,
      originLng: input.originLng ?? null,
      consigneeName: input.consigneeName,
      consigneePhone: input.consigneePhone,
      destAddress: input.destAddress,
      destLat: input.destLat ?? null,
      destLng: input.destLng ?? null,
      destZoneId: input.destZoneId ?? null,
      createdAt: chain[0]?.at ?? new Date(),
      updatedAt: chain[chain.length - 1]?.at ?? new Date(),
    })
    .returning();

  let previous: ParcelStatus | null = null;
  for (const step of chain) {
    await db.insert(parcelEvent).values({
      id: prefixedId("pev"),
      parcelId: row!.id,
      fromStatus: previous,
      toStatus: step.status,
      actorName: step.actorName,
      actorRole: step.actorRole,
      ts: step.at,
    });
    previous = step.status;
  }
  return row!;
}

/**
 * Increment the parcel's delivery-attempt counter and return the new total.
 *
 * Owned here because `parcels_parcel` is this module's table (§4). The delivery
 * module counts attempts from its own append-only `delivery_attempt` rows and
 * calls this to keep the denormalised counter on the parcel in step — the
 * counter is what §6's "maximum 3 delivery attempts" rule is read from on the
 * hot path, and what the rider's app shows without a second query.
 *
 * Only failures that the reason code marks `countsAsAttempt` reach here: a
 * flood or a van breakdown is NatEx's failure, not the consignee's.
 */
export async function incrementDeliveryAttempts(parcelId: string): Promise<number> {
  const row = await getParcelById(parcelId);
  if (!row) errors.notFound(`Parcel ${parcelId}`);
  const next = row!.deliveryAttempts + 1;
  await db
    .update(parcel)
    .set({ deliveryAttempts: next, updatedAt: new Date() })
    .where(eq(parcel.id, parcelId));
  return next;
}

/**
 * Correct a consignee's delivery details after an NDR `address_change`
 * instruction, recording the change as a parcel event.
 *
 * The status is deliberately NOT touched: a corrected address and a state
 * change are two separate facts and are never conflated in one silent write
 * (same rule as reassignBranch above).
 */
export async function updateDeliveryDetails(
  parcelId: string,
  patch: {
    destAddress?: string | null;
    consigneePhone?: string | null;
    destLat?: number | null;
    destLng?: number | null;
  },
  actor: Principal,
  notes: string,
): Promise<ParcelRow> {
  const row = await getParcelById(parcelId);
  if (!row) errors.notFound(`Parcel ${parcelId}`);
  assertVisible(row!, actor);

  const changes: string[] = [];
  if (patch.destAddress && patch.destAddress !== row!.destAddress) {
    changes.push(`address "${row!.destAddress}" → "${patch.destAddress}"`);
  }
  if (patch.consigneePhone && patch.consigneePhone !== row!.consigneePhone) {
    changes.push(`phone ${row!.consigneePhone} → ${patch.consigneePhone}`);
  }
  if (changes.length === 0) return row!;

  const [updated] = await db
    .update(parcel)
    .set({
      destAddress: patch.destAddress ?? row!.destAddress,
      consigneePhone: patch.consigneePhone ?? row!.consigneePhone,
      // A new address invalidates the old coordinates; null is honest.
      destLat: patch.destAddress ? (patch.destLat ?? null) : row!.destLat,
      destLng: patch.destAddress ? (patch.destLng ?? null) : row!.destLng,
      updatedAt: new Date(),
    })
    .where(eq(parcel.id, parcelId))
    .returning();

  await appendParcelEvent({
    parcelId,
    fromStatus: row!.status as ParcelStatus,
    toStatus: row!.status as ParcelStatus,
    actor,
    notes: `${notes} Changed: ${changes.join("; ")}.`,
  });

  return updated!;
}

// ------------------------------------------------- delta reads for §7 sync

/**
 * Parcels this principal can see that changed after a watermark, oldest change
 * first (PROJECT.md §7: "fetch changes since the client's cursor — never the
 * whole dataset").
 *
 * Lives here, not in modules/sync, because §4 forbids another module reading
 * parcels_*. The sync module calls this and owns only the cursor arithmetic.
 *
 * Ordered ASC by `updatedAt` on purpose: the caller advances its cursor to the
 * last row it actually received, so a page boundary can never skip a record.
 * `limit` is a page size, not a filter — `hasMore` tells the client to pull
 * again immediately rather than wait for the next reconnect.
 */
export async function parcelsChangedSince(
  scope: Principal,
  sinceMs: number,
  limit = 200,
): Promise<{ rows: ParcelRow[]; hasMore: boolean; watermarkMs: number }> {
  const pageSize = Math.min(Math.max(limit, 1), 500);
  const filters = [scopeFilter(scope), sql`${parcel.updatedAt} > ${sinceMs}`];
  const rows = await db
    .select()
    .from(parcel)
    .where(and(...filters.filter((f) => f !== undefined)))
    .orderBy(asc(parcel.updatedAt))
    // One extra row is fetched purely to answer hasMore without a COUNT.
    .limit(pageSize + 1);

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page.at(-1);
  return {
    rows: page,
    hasMore,
    watermarkMs: last?.updatedAt ? last.updatedAt.getTime() : sinceMs,
  };
}

/**
 * The event timeline for a set of parcels since a watermark, so a reconnecting
 * device can rebuild a custody history it never saw rather than only the
 * current status.
 */
export async function eventsChangedSince(
  parcelIds: string[],
  sinceMs: number,
  limit = 400,
): Promise<ParcelEventRow[]> {
  if (parcelIds.length === 0) return [];
  return db
    .select()
    .from(parcelEvent)
    .where(and(inArray(parcelEvent.parcelId, parcelIds), sql`${parcelEvent.ts} > ${sinceMs}`))
    .orderBy(asc(parcelEvent.ts))
    .limit(Math.min(Math.max(limit, 1), 1000));
}

/** Total parcel rows — used by the seed script to stay idempotent. */
export async function parcelCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(parcel);
  return row?.value ?? 0;
}

export { sql };
