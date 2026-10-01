import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * MODULE: routing — serviceability zones and nearest-branch lookup.
 * PROJECT.md §4: only modules/routing/service.ts reads these tables.
 *
 * KNOWN DEVIATION (PROJECT.md §5 requires PostGIS):
 * Runable's managed stack is SQLite/Turso with no PostGIS and no GiST index, so
 * a zone is stored as an axis-aligned bounding box plus an optional polygon ring
 * (JSON). Containment runs as bbox pre-filter + JS ray-casting on the ring,
 * which approximates ST_Contains; nearest-branch uses Haversine instead of the
 * `<->` geography operator. Accurate for the rectangular pilot zones seeded here,
 * but NOT equivalent for complex boundaries. Logged in README "Known deviations".
 */

export const zone = sqliteTable(
  "routing_zone",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    branchId: text("branch_id").notNull(),
    /** Bounding box in microdegrees (1e-6 deg) — integer math, no float drift. */
    minLat: integer("min_lat_e6").notNull(),
    minLng: integer("min_lng_e6").notNull(),
    maxLat: integer("max_lat_e6").notNull(),
    maxLng: integer("max_lng_e6").notNull(),
    /** Optional polygon ring: JSON [[latE6, lngE6], ...]. Null = plain bbox zone. */
    ring: text("ring"),
    serviceable: integer("serviceable", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("routing_zone_branch_idx").on(t.branchId)],
);

/**
 * Geocode cache — "the same address is never sent to Google Maps twice"
 * (PROJECT.md §5). Keyed by a normalised address hash.
 */
export const geocodeCache = sqliteTable("routing_geocode_cache", {
  addressKey: text("address_key").primaryKey(),
  address: text("address").notNull(),
  lat: integer("lat_e6").notNull(),
  lng: integer("lng_e6").notNull(),
  provider: text("provider").notNull().default("seed"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
