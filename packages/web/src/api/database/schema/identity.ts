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
    /** rider | transport | ops | finance | admin | merchant — the PRIMARY role (roles[0]). */
    role: text("role").notNull(),
    /**
     * Every role the user holds, as a JSON array. Empty string = legacy row:
     * read it as [role]. roles[0] is always mirrored into `role`, so single-role
     * code paths (branch scope, "last admin" counts) keep working.
     */
    roles: text("roles").notNull().default(""),
    /** Username/password sign-in, set by an admin. Either may be null. */
    username: text("username").unique(),
    passwordHash: text("password_hash"),
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
    /**
     * M5 (§2 TOTP MFA for ops/admin/finance). What the sign-in that started
     * this session proved: `none` (role needs no MFA), `enrol` (an MFA role
     * that has not enrolled yet — the session may only enrol), `verified`
     * (OTP + TOTP). Carried unchanged through every rotation.
     */
    mfaLevel: text("mfa_level").notNull().default("none"),
    /**
     * When the session family began (the sign-in), carried through rotations,
     * so the absolute-lifetime policy cannot be dodged by refreshing forever.
     * Null on rows written before M5 — those fall back to `createdAt`.
     */
    familyStartedAt: integer("family_started_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("identity_refresh_user_idx").on(t.userId)],
);

/**
 * TOTP second factor (PROJECT.md §2: "TOTP MFA for ops/admin/finance").
 * One factor per user. The shared secret is encrypted at rest (AES-256-GCM,
 * shared/secret-box.ts) — it has to be recoverable to verify a code, so it
 * cannot be hashed like an OTP.
 */
export const mfaFactor = sqliteTable("identity_mfa_factor", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id),
  secretEnc: text("secret_enc").notNull(),
  /** Null until the user proves the authenticator works with a first code. */
  confirmedAt: integer("confirmed_at", { mode: "timestamp" }),
  /**
   * The last 30-second step accepted. RFC 6238 §5.2: a verifier must not
   * accept the same code twice, so a code is only good for a step after this.
   */
  lastStep: integer("last_step").notNull().default(0),
  /** Seeded with the development secret (never in production). */
  seeded: integer("seeded", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Single-use recovery codes, stored as SHA-256 fingerprints. */
export const mfaRecoveryCode = sqliteTable(
  "identity_mfa_recovery_code",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    codeHash: text("code_hash").notNull(),
    usedAt: integer("used_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("identity_mfa_recovery_user_idx").on(t.userId)],
);
