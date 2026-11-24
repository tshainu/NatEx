import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const riderGpsDay = sqliteTable(
  "rider_gps_day",
  {
    id: text("id").primaryKey(),
    riderId: text("rider_id").notNull(),
    workDate: text("work_date").notNull(),
    clockInAt: integer("clock_in_at", { mode: "timestamp" }).notNull(),
    clockOutAt: integer("clock_out_at", { mode: "timestamp" }),
    distanceMeters: integer("distance_meters").notNull().default(0),
    acceptedPoints: integer("accepted_points").notNull().default(0),
    rejectedPoints: integer("rejected_points").notNull().default(0),
    lastPointAt: integer("last_point_at", { mode: "timestamp" }),
    syncState: text("sync_state").notNull().default("live"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("rider_gps_day_rider_date_uq").on(t.riderId, t.workDate), index("rider_gps_day_date_idx").on(t.workDate)],
);

export const riderGpsPoint = sqliteTable(
  "rider_gps_point",
  {
    id: text("id").primaryKey(),
    dayId: text("day_id").notNull().references(() => riderGpsDay.id),
    clientPointId: text("client_point_id").notNull(),
    capturedAt: integer("captured_at", { mode: "timestamp" }).notNull(),
    latitudeE6: integer("latitude_e6").notNull(),
    longitudeE6: integer("longitude_e6").notNull(),
    accuracyMeters: integer("accuracy_meters").notNull(),
    speedMps: integer("speed_mps").notNull().default(0),
    accepted: integer("accepted", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("rider_gps_point_client_uq").on(t.dayId, t.clientPointId), index("rider_gps_point_day_time_idx").on(t.dayId, t.capturedAt)],
);
