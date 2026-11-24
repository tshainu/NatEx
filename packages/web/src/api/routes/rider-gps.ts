import { z } from "zod";
import { authedProc, mutate, riderProc } from "../middleware/pipeline";
import { requireRole } from "../middleware/auth";
import * as gps from "../modules/rider-gps/service";
import { isValidIsoDate } from "../modules/hr/validation";

const isoDay = z.string().refine(isValidIsoDate, "Use YYYY-MM-DD.");
const point = z.object({ clientPointId: z.string().min(8).max(100), capturedAt: z.string().datetime(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracyMeters: z.number().min(0).max(10000), speedMps: z.number().min(0).max(1000).nullish() });
const reportProc = authedProc.use(requireRole("rider", "ops", "hr", "finance", "admin", "super_admin", "nos_admin"));

export const start = riderProc.input(z.object({ workDate: isoDay.optional() }).default({})).handler(({ context, input }) => mutate(context, input, { route: "riderGps.start", entity: "rider_gps_day", entityId: () => `${context.principal.userId}:${input.workDate ?? "today"}`, action: "rider.gps_started" }, () => gps.startDay(context.principal, input.workDate)));
export const points = riderProc.input(z.object({ workDate: isoDay.optional(), points: z.array(point).min(1).max(500) })).handler(({ context, input }) => mutate(context, input, { route: "riderGps.points", entity: "rider_gps_day", entityId: () => `${context.principal.userId}:${input.workDate ?? "today"}`, action: "rider.gps_points_synced" }, () => gps.appendPoints(context.principal, input.points, input.workDate)));
export const finish = riderProc.input(z.object({ workDate: isoDay.optional() }).default({})).handler(({ context, input }) => mutate(context, input, { route: "riderGps.finish", entity: "rider_gps_day", entityId: () => `${context.principal.userId}:${input.workDate ?? "today"}`, action: "rider.gps_finished" }, () => gps.finishDay(context.principal, input.workDate)));
export const own = riderProc.input(z.object({ workDate: isoDay.optional() }).default({})).handler(({ context, input }) => gps.ownDay(context.principal, input.workDate));
export const report = reportProc.input(z.object({ from: isoDay, to: isoDay, riderId: z.string().optional(), branchId: z.string().optional() }).refine((value) => value.from <= value.to, "End date must be on or after start date.")).handler(({ context, input }) => gps.report(input, context.principal));

export const riderGps = { start, points, finish, own, report };
