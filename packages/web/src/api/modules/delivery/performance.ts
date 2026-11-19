import { and, asc, count, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../../database";
import { deliveryAttempt, riderDailyPerformance, runsheet, runsheetItem } from "../../database/schema/delivery";
import { errors } from "../../shared/errors";
import { addDays } from "../../shared/time";
import { operationsBranchScope } from "../identity/service";
import type { Principal } from "../../shared/auth";
import { prefixedId } from "../../shared/ulid";

const TARGET = 40;
const RATE_CENTS = 4_000;
const CUTOFF_HOUR = 17;

function cutoff(day: string): Date {
  return new Date(`${day}T${String(CUTOFF_HOUR).padStart(2, "0")}:00:00+05:30`);
}
function startOfDay(day: string): Date {
  return new Date(`${day}T00:00:00+05:30`);
}

export async function riderPerformance(input: {
  fromDate: string;
  toDate: string;
  branchId?: string;
  riderId?: string;
}, actor: Principal) {
  if (input.fromDate > input.toDate) errors.badRequest("Performance start date must be on or before end date.");
  const authorized = actor.role === "admin" || actor.role === "hr" || actor.role === "finance"
    ? null
    : await operationsBranchScope(actor.branchId);
  if (input.branchId && authorized && !authorized.includes(input.branchId)) errors.forbidden("You may only report on your assigned branch and child branches.");
  const branchIds = input.branchId ? [input.branchId] : authorized;
  const days: string[] = [];
  for (let current = input.fromDate; current <= input.toDate; current = addDays(current, 1)) days.push(current);
  const rows: Array<{
    date: string; riderId: string; riderName: string; branchId: string; hubId: string;
    assignedCount: number; deliveredByCutoff: number; targetCount: number; starCount: number; rateCents: number; payableCents: number;
  }> = [];
  for (const day of days) {
    const runFilters = [eq(runsheet.runDate, day), sql`${runsheet.status} <> 'cancelled'`];
    if (branchIds) runFilters.push(sql`${runsheet.branchId} IN (${sql.join(branchIds.map((id) => sql`${id}`), sql`, `)})`);
    if (input.riderId) runFilters.push(eq(runsheet.riderId, input.riderId));
    const assigned = await db.select({
      riderId: runsheet.riderId,
      riderName: runsheet.riderName,
      branchId: runsheet.branchId,
      hubId: runsheet.hubId,
      assignedCount: count(runsheetItem.id),
    }).from(runsheet).innerJoin(runsheetItem, eq(runsheetItem.runsheetId, runsheet.id))
      .where(and(...runFilters)).groupBy(runsheet.riderId, runsheet.riderName, runsheet.branchId, runsheet.hubId);
    const deliveredFilters = [eq(deliveryAttempt.outcome, "delivered"), gte(deliveryAttempt.ts, startOfDay(day)), lt(deliveryAttempt.ts, cutoff(day))];
    if (input.riderId) deliveredFilters.push(eq(deliveryAttempt.riderId, input.riderId));
    const delivered = await db.select({ riderId: deliveryAttempt.riderId, deliveredCount: count(sql`DISTINCT ${deliveryAttempt.parcelId}`) })
      .from(deliveryAttempt).where(and(...deliveredFilters)).groupBy(deliveryAttempt.riderId);
    const deliveredByRider = new Map(delivered.map((row) => [row.riderId, Number(row.deliveredCount)]));
    for (const row of assigned) {
      const assignedCount = Number(row.assignedCount);
      const deliveredByCutoff = deliveredByRider.get(row.riderId) ?? 0;
      const targetCount = Math.min(TARGET, assignedCount);
      const starCount = Math.max(0, deliveredByCutoff - targetCount);
      rows.push({ date: day, riderId: row.riderId, riderName: row.riderName, branchId: row.branchId, hubId: row.hubId, assignedCount, deliveredByCutoff, targetCount, starCount, rateCents: RATE_CENTS, payableCents: starCount * RATE_CENTS });
    }
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.riderName.localeCompare(b.riderName));
}

export async function listStarPayouts(input: { fromDate: string; toDate: string; branchId?: string }, actor: Principal) {
  const authorized = actor.role === "admin" || actor.role === "hr" || actor.role === "finance" ? null : await operationsBranchScope(actor.branchId);
  if (input.branchId && authorized && !authorized.includes(input.branchId)) errors.forbidden("You may only view your assigned branch scope.");
  const rows = await db.select().from(riderDailyPerformance).orderBy(asc(riderDailyPerformance.performanceDate), asc(riderDailyPerformance.riderName));
  return rows.filter((row) => row.performanceDate >= input.fromDate && row.performanceDate <= input.toDate && (!input.branchId || row.branchId === input.branchId) && (!authorized || authorized.includes(row.branchId)));
}

export async function generateStarPayouts(input: { fromDate: string; toDate: string }, actor: Principal) {
  const rows = await riderPerformance(input, actor);
  for (const row of rows) {
    const [existing] = await db.select().from(riderDailyPerformance).where(and(eq(riderDailyPerformance.riderId, row.riderId), eq(riderDailyPerformance.performanceDate, row.date)));
    if (existing?.status === "paid") continue;
    const values = {
      riderId: row.riderId, riderName: row.riderName, branchId: row.branchId, hubId: row.hubId,
      performanceDate: row.date, assignedCount: row.assignedCount, deliveredByCutoff: row.deliveredByCutoff,
      targetCount: row.targetCount, starCount: row.starCount, rateCents: row.rateCents, payableCents: row.payableCents,
      updatedAt: new Date(),
    };
    if (existing) await db.update(riderDailyPerformance).set(values).where(eq(riderDailyPerformance.id, existing.id));
    else await db.insert(riderDailyPerformance).values({ id: prefixedId("rdp"), ...values, status: "unpaid" });
  }
  return listStarPayouts(input, actor);
}

export async function updateStarPayoutStatus(input: { ids: string[]; status: "review" | "approved" | "rejected" | "paid" }, actor: Principal) {
  if (input.ids.length === 0 || input.ids.length > 500) errors.badRequest("Select between 1 and 500 star-delivery rows.");
  const rows = await db.select().from(riderDailyPerformance).where(sql`${riderDailyPerformance.id} IN (${sql.join(input.ids.map((id) => sql`${id}`), sql`, `)})`);
  if (rows.length !== input.ids.length) errors.notFound("One or more star-delivery rows");
  for (const row of rows) {
    if (row.status === "paid" && input.status !== "paid") errors.conflict("Paid star-delivery rows cannot be moved backward.");
    await db.update(riderDailyPerformance).set({ status: input.status, reviewedBy: actor.userId, reviewedAt: new Date(), ...(input.status === "paid" ? { paidBy: actor.userId, paidAt: new Date() } : {}) }).where(eq(riderDailyPerformance.id, row.id));
  }
  return rows.map((row) => ({ ...row, status: input.status }));
}
