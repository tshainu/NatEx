import { describe, expect, test } from "bun:test";
import { hardenScriptReads } from "./db-retry";

const reset = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
function fakeDb(failures: number, err: () => Error = reset) {
  const calls: string[] = [];
  let left = failures;
  const client = {
    execute: async (stmt: string | { sql: string }) => {
      calls.push(typeof stmt === "string" ? stmt : stmt.sql);
      if (left-- > 0) throw new Error("Failed query", { cause: err() });
      return { rows: [] };
    },
  };
  return { db: { $client: client }, calls };
}

describe("hardenScriptReads", () => {
  test("a SELECT on a reset socket is retried and succeeds", async () => {
    const { db, calls } = fakeDb(2);
    hardenScriptReads(db);
    await expect((db.$client as { execute: (s: unknown) => Promise<unknown> }).execute({ sql: "select 1" })).resolves.toEqual({ rows: [] });
    expect(calls.length).toBe(3);
  });
  test("a write is never replayed", async () => {
    const { db, calls } = fakeDb(1);
    hardenScriptReads(db);
    await expect((db.$client as { execute: (s: unknown) => Promise<unknown> }).execute({ sql: "insert into t values (1)" })).rejects.toThrow();
    expect(calls.length).toBe(1);
  });
  test("a non-network error is not retried", async () => {
    const { db, calls } = fakeDb(1, () => new Error("no such column: x"));
    hardenScriptReads(db);
    await expect((db.$client as { execute: (s: unknown) => Promise<unknown> }).execute("select x")).rejects.toThrow();
    expect(calls.length).toBe(1);
  });
  test("gives up after the attempt budget", async () => {
    const { db, calls } = fakeDb(10);
    hardenScriptReads(db, 3);
    await expect((db.$client as { execute: (s: unknown) => Promise<unknown> }).execute("select 1")).rejects.toThrow();
    expect(calls.length).toBe(3);
  });
  test("hardening twice does not stack retries", async () => {
    const { db, calls } = fakeDb(10);
    hardenScriptReads(db, 2);
    hardenScriptReads(db, 2);
    await expect((db.$client as { execute: (s: unknown) => Promise<unknown> }).execute("select 1")).rejects.toThrow();
    expect(calls.length).toBe(2);
  });
});
