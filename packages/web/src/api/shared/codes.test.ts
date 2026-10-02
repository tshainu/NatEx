import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CODE_SUFFIX_LENGTH, insertWithFreshCode, mintDocumentCode } from "./codes";

// A real SQLite (in-memory libsql) so the error shape is exactly what Drizzle
// throws in production — DrizzleQueryError wrapping a LibsqlError — not a mock.
const doc = sqliteTable("doc", { id: text("id").primaryKey(), code: text("code").notNull().unique() });
async function freshDb() {
  const client = createClient({ url: ":memory:" });
  await client.execute("create table doc (id text primary key, code text not null unique)");
  return drizzle(client);
}

describe("mintDocumentCode", () => {
  test("prefix + yymmdd + 6 Crockford base32 characters", () => {
    const code = mintDocumentCode("DSP", "2026-10-02");
    expect(code).toMatch(new RegExp(`^DSP261002-[0-9A-HJKMNP-TV-Z]{${CODE_SUFFIX_LENGTH}}$`));
  });
  test("10 000 codes for one prefix and day do not collide (the old 4-digit suffix would, near-certainly)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(mintDocumentCode("STL", "2026-10-02"));
    // Expected collisions at 32^6 ≈ 1.07e9 is ~0.05, so ≥10 is effectively
    // impossible; the old 9 000-value suffix could not even hold 10 000 codes.
    expect(seen.size).toBeGreaterThanOrEqual(9_990);
  });
});

describe("insertWithFreshCode (against a real SQLite UNIQUE index)", () => {
  test("re-mints on a code collision instead of failing", async () => {
    const db = await freshDb();
    await db.insert(doc).values({ id: "a", code: "DSP261002-TAKEN0" });
    const mints = ["DSP261002-TAKEN0", "DSP261002-TAKEN0", "DSP261002-FRESH1"];
    const { code } = await insertWithFreshCode("doc", () => mints.shift()!, (code) => db.insert(doc).values({ id: "b", code }));
    expect(code).toBe("DSP261002-FRESH1");
    expect((await db.select().from(doc)).map((r) => r.code).sort()).toEqual(["DSP261002-FRESH1", "DSP261002-TAKEN0"]);
  });
  test("any other constraint failure propagates on the first attempt", async () => {
    const db = await freshDb();
    await db.insert(doc).values({ id: "a", code: "X1" });
    let calls = 0;
    const attempt = insertWithFreshCode("doc", () => `X${++calls + 1}`, (code) => db.insert(doc).values({ id: "a", code }));
    await expect(attempt).rejects.toThrow();
    expect(calls).toBe(1); // a primary-key clash is not a code clash: never retried
  });
  test("gives up after the attempt budget and surfaces the real error", async () => {
    const db = await freshDb();
    await db.insert(doc).values({ id: "a", code: "SAME" });
    let calls = 0;
    const attempt = insertWithFreshCode("doc", () => (calls++, "SAME"), (code) => db.insert(doc).values({ id: `n${calls}`, code }), 3);
    await expect(attempt).rejects.toThrow();
    expect(calls).toBe(3);
  });
  test("returns the insert's own result", async () => {
    const db = await freshDb();
    const { result } = await insertWithFreshCode("doc", () => "R1", (code) => db.insert(doc).values({ id: "r", code }).returning());
    expect(result).toEqual([{ id: "r", code: "R1" }]);
  });
});
