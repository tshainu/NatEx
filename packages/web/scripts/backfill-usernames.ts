/**
 * One-off M6 data migration for databases seeded before username/password
 * sign-in and multi-role users existed (the schema columns ship empty):
 *
 *   1. roles   — every row still carrying the empty default gets [role]
 *   2. logins  — the seeded staff personas get their README username and the
 *                seed password (natex123), so the rider app can sign in
 *
 * Idempotent: rows that already hold a username are skipped, and the roles
 * backfill only touches empty values. Safe to run against any environment.
 *
 * Run:  bun --env-file=../../.env scripts/backfill-usernames.ts
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../src/api/database";
import { user } from "../src/api/database/schema/identity";
import { hashSecret } from "../src/api/shared/auth";

const SEED_PASSWORD = "natex123";

/** phone → username, mirroring src/api/database/seed.ts. */
const SEED_USERNAMES: Array<[string, string]> = [
  ["+94771234567", "karthik"],
  ["+94772345678", "priya"],
  ["+94773456789", "arjun"],
  ["+94774567890", "kavitha"],
  ["+94776789012", "murugan"],
  ["+94777890123", "vignesh"],
  ["+94779012345", "lakshmi"],
  ["+94778901234", "senthil"],
  ["+94775678901", "sanjay"],
];

const rolesResult = await db.run(
  sql`update identity_user set roles = json_array(role) where roles = '' or roles is null`,
);
console.log(`roles backfilled: ${rolesResult.rowsAffected} row(s)`);

const passwordHash = await hashSecret(SEED_PASSWORD);
for (const [phone, username] of SEED_USERNAMES) {
  const result = await db
    .update(user)
    .set({ username, passwordHash })
    .where(and(eq(user.phone, phone), isNull(user.username)));
  if (result.rowsAffected) console.log(`login set: ${username} (${phone})`);
}
console.log("backfill complete");
