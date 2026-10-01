import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * MODULE: identity — owns branches, users, roles, sessions.
 * PROJECT.md §4: no other module may SELECT from these tables.
 * Access goes through modules/identity/service.ts.
 *
 * Table names are prefixed with the owning module (identity_*) because SQLite
 * has no schemas. This is the SQLite stand-in for PostgreSQL's `identity.*`.
 */

export const branch = sqliteTable("identity_branch", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  address: text("address").notNull(),
  /** Geocoded once and stored forever (PROJECT.md §5). Never re-sent to Maps. */
  lat: integer("lat_e6").notNull(),
  lng: integer("lng_e6").notNull(),
  /** hub | branch */
  type: text("type").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const user = sqliteTable(
  "identity_user",
  {
    id: text("id").primaryKey(),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id),
    /** rider | transport | ops | finance | admin | merchant */
    role: text("role").notNull(),
    name: text("name").notNull(),
    phone: text("phone").notNull().unique(),
    /** One active device per rider (PROJECT.md §5). */
    deviceId: text("device_id"),
    /** active | suspended */
    status: text("status").notNull().default("active"),
    /** Set for merchant-portal users; null for staff. */
    merchantId: text("merchant_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("identity_user_branch_idx").on(t.branchId)],
);

/** Phone OTP challenges. Hashed, single-use, short TTL. */
export const otpChallenge = sqliteTable(
  "identity_otp_challenge",
  {
    id: text("id").primaryKey(),
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
    attempts: integer("attempts").notNull().default(0),
    /** Gateway reference id, if the SMS gateway returned one. Opaque. */
    smsRef: text("sms_ref"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("identity_otp_phone_idx").on(t.phone)],
);

/** Rotating refresh tokens — a used token is revoked and replaced (PROJECT.md §2). */
export const refreshToken = sqliteTable(
  "identity_refresh_token",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    tokenHash: text("token_hash").notNull(),
    deviceId: text("device_id"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    /** Set when this token was rotated into a successor. */
    replacedById: text("replaced_by_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("identity_refresh_user_idx").on(t.userId)],
);
