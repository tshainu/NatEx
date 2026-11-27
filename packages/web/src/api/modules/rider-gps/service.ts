import { and, asc, desc, eq, gte, isNull, lt, lte } from "drizzle-orm";
import { db } from "../../database";
import { riderGpsDay, riderGpsPoint } from "../../database/schema/rider-gps";
import { hrEmployee } from "../../database/schema/hr";
import type { Principal } from "../../shared/auth";
import { errors } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { colomboToday } from "../../shared/time";
import { operationsBranchScope } from "../identity/service";

export const MAX_ACCURACY_METERS = 100;
export const MAX_SPEED_MPS = 33;
const RETENTION_DAYS = 90;

type PointInput = { clientPointId: string; capturedAt: string; latitude: number; longitude: number; accuracyMeters: number; speedMps?: number | null };

export function haversineMeters(a: { latitudeE6: number; longitudeE6: number }, b: { latitudeE6: number; longitudeE6: number }) {
  const r = 6371000;
  const lat1 = a.latitudeE6 / 1e6 * Math.PI / 180;
  const lat2 = b.latitudeE6 / 1e6 * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (b.longitudeE6 - a.longitudeE6) / 1e6 * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * r * Math.asin(Math.sqrt(h)));
}

export function gpsPointIsValid(point: PointInput, now = Date.now()) {
  const capturedAt = new Date(point.capturedAt).getTime();
  const accuracy = Math.round(point.accuracyMeters);
  const speed = Math.max(0, Math.round(point.speedMps ?? 0));
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && point.latitude >= -90 && point.latitude <= 90 && point.longitude >= -180 && point.longitude <= 180 && accuracy >= 0 && accuracy <= MAX_ACCURACY_METERS && speed <= MAX_SPEED_MPS && Number.isFinite(capturedAt) && capturedAt <= now + 60_000;
}

export function gpsSegmentIsValid(distanceMeters: number, elapsedSeconds: number) {
  return distanceMeters <= 5000 && distanceMeters / Math.max(1, elapsedSeconds) <= MAX_SPEED_MPS;
}

async function dayFor(principal: Principal, workDate = colomboToday()) {
  const [day] = await db.select().from(riderGpsDay).where(and(eq(riderGpsDay.riderId, principal.userId), eq(riderGpsDay.workDate, workDate))).limit(1);
  return day ?? null;
}

export async function startDay(principal: Principal, workDate = colomboToday()) {
  const existing = await dayFor(principal, workDate);
  // Attendance can be clocked in/out more than once on the same day. Reopen
  // the single daily GPS record so all segments remain in one combined route
  // and distance total instead of making a later clock-in fail.
  if (existing?.clockOutAt) {
    const [reopened] = await db.update(riderGpsDay).set({ clockOutAt: null, syncState: "live", updatedAt: new Date() }).where(eq(riderGpsDay.id, existing.id)).returning();
    return reopened!;
  }
  if (existing) return existing;
  const [day] = await db.insert(riderGpsDay).values({ id: prefixedId("gps"), riderId: principal.userId, workDate, clockInAt: new Date(), syncState: "live" }).returning();
  return day!;
}

export async function appendPoints(principal: Principal, points: PointInput[], workDate = colomboToday()) {
  if (!points.length) return { accepted: 0, rejected: 0, distanceMeters: (await dayFor(principal, workDate))?.distanceMeters ?? 0 };
  const day = await dayFor(principal, workDate);
  if (!day) errors.conflict("Clock in before starting GPS tracking.");
  if (day!.clockOutAt) errors.conflict("GPS tracking has ended for today.");
  const previous = await db.select().from(riderGpsPoint).where(and(eq(riderGpsPoint.dayId, day!.id), eq(riderGpsPoint.accepted, true))).orderBy(desc(riderGpsPoint.capturedAt)).limit(1);
  let last: { latitudeE6: number; longitudeE6: number; capturedAt: Date } | null = previous[0] ?? null;
  let distance = 0;
  let accepted = 0;
  let rejected = 0;
  const now = Date.now();
  for (const point of [...points].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))) {
    const capturedAt = new Date(point.capturedAt);
    const accuracy = Math.round(point.accuracyMeters);
    const speed = Math.max(0, Math.round(point.speedMps ?? 0));
    const valid = gpsPointIsValid(point, now);
    if (!valid) { rejected += 1; continue; }
    const current = { latitudeE6: Math.round(point.latitude * 1e6), longitudeE6: Math.round(point.longitude * 1e6) };
    if (last) {
      const segment = haversineMeters(last, current);
      const seconds = Math.max(1, (capturedAt.getTime() - last.capturedAt.getTime()) / 1000);
      if (!gpsSegmentIsValid(segment, seconds)) { rejected += 1; continue; }
      distance += segment;
    }
    const inserted = await db.insert(riderGpsPoint).values({ id: prefixedId("gpt"), dayId: day!.id, clientPointId: point.clientPointId, capturedAt, latitudeE6: current.latitudeE6, longitudeE6: current.longitudeE6, accuracyMeters: accuracy, speedMps: speed, accepted: true }).onConflictDoNothing({ target: [riderGpsPoint.dayId, riderGpsPoint.clientPointId] }).returning({ id: riderGpsPoint.id });
    if (!inserted.length) continue;
    last = { ...current, capturedAt };
    accepted += 1;
  }
  const [updated] = await db.update(riderGpsDay).set({ distanceMeters: day!.distanceMeters + distance, acceptedPoints: day!.acceptedPoints + accepted, rejectedPoints: day!.rejectedPoints + rejected, lastPointAt: last?.capturedAt ?? day!.lastPointAt, syncState: "live", updatedAt: new Date() }).where(eq(riderGpsDay.id, day!.id)).returning();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  await db.delete(riderGpsPoint).where(lt(riderGpsPoint.capturedAt, cutoff));
  return { accepted, rejected, distanceMeters: updated?.distanceMeters ?? day!.distanceMeters };
}

export async function finishDay(principal: Principal, workDate = colomboToday()) {
  const day = await dayFor(principal, workDate);
  if (!day) errors.conflict("No GPS tracking session exists for today.");
  if (!day!.clockOutAt) {
    const [updated] = await db.update(riderGpsDay).set({ clockOutAt: new Date(), syncState: "complete", updatedAt: new Date() }).where(eq(riderGpsDay.id, day!.id)).returning();
    return updated!;
  }
  return day!;
}

function canViewAll(principal: Principal) { return ["admin", "super_admin", "nos_admin", "hr", "finance", "gom"].includes(principal.role); }

/** Close abandoned sessions from earlier Colombo dates at the next nightly tick. */
export async function closeStaleDays(workDate = colomboToday()) {
  const rows = await db.update(riderGpsDay).set({ clockOutAt: new Date(), syncState: "complete", updatedAt: new Date() }).where(and(lt(riderGpsDay.workDate, workDate), isNull(riderGpsDay.clockOutAt))).returning({ id: riderGpsDay.id });
  return rows.length;
}

export async function ownDay(principal: Principal, workDate = colomboToday()) {
  const day = await dayFor(principal, workDate);
  if (!day) return { day: null, points: [] };
  const points = await db.select().from(riderGpsPoint).where(and(eq(riderGpsPoint.dayId, day.id), eq(riderGpsPoint.accepted, true))).orderBy(asc(riderGpsPoint.capturedAt));
  return { day, points: points.map((point) => ({ latitude: point.latitudeE6 / 1e6, longitude: point.longitudeE6 / 1e6, capturedAt: point.capturedAt, accuracyMeters: point.accuracyMeters })) };
}

export async function report(input: { from: string; to: string; riderId?: string; branchId?: string }, principal: Principal) {
  const rows = await db.select({ day: riderGpsDay, employee: hrEmployee }).from(riderGpsDay).innerJoin(hrEmployee, eq(hrEmployee.identityUserId, riderGpsDay.riderId)).where(and(gte(riderGpsDay.workDate, input.from), lte(riderGpsDay.workDate, input.to))).orderBy(desc(riderGpsDay.workDate), desc(riderGpsDay.clockInAt));
  const branchIds = principal.role === "ops" && principal.branchId ? await operationsBranchScope(principal.branchId) : null;
  const scoped = rows.filter(({ day, employee }) => (!input.riderId || day.riderId === input.riderId) && (!input.branchId || employee.branchId === input.branchId) && (canViewAll(principal) || principal.role === "ops" && branchIds?.includes(employee.branchId) || day.riderId === principal.userId));
  const result = await Promise.all(scoped.map(async ({ day, employee }) => ({ day, riderId: day.riderId, riderName: employee.fullName, employeeCode: employee.employeeCode, branchId: employee.branchId, points: (await db.select().from(riderGpsPoint).where(and(eq(riderGpsPoint.dayId, day.id), eq(riderGpsPoint.accepted, true))).orderBy(asc(riderGpsPoint.capturedAt))).map((point) => ({ latitude: point.latitudeE6 / 1e6, longitude: point.longitudeE6 / 1e6, capturedAt: point.capturedAt, accuracyMeters: point.accuracyMeters })) })));
  return result;
}
