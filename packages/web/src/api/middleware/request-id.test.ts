import { describe, expect, test } from "bun:test";
import { call } from "@orpc/server";
import { z } from "zod";
import { publicProc } from "./pipeline";
import { isTransientDbError, markWrite } from "../shared/request-scope";

/**
 * The transient-database retry in withRequestId: a Turso socket reset on a
 * read is re-run, a write is never replayed, a real bug is never masked.
 */

/** Shaped like the live failure: DrizzleQueryError → FetchError ECONNRESET. */
function turso500(): Error {
  const fetchErr = Object.assign(
    new Error("request to https://x.turso.io/v2/pipeline failed, reason: socket hang up"),
    { code: "ECONNRESET", errno: "ECONNRESET", type: "system" },
  );
  return Object.assign(new Error('Failed query: select count(*) from "collection_pickup_request"'), {
    cause: fetchErr,
  });
}

const ctx = () => ({ context: { headers: new Headers() } });

describe("isTransientDbError", () => {
  test("finds the reset on the cause chain", () => {
    expect(isTransientDbError(turso500())).toBe(true);
    expect(isTransientDbError(new TypeError("The socket connection was closed unexpectedly"))).toBe(true);
  });
  test("ignores ordinary failures", () => {
    expect(isTransientDbError(new Error("UNIQUE constraint failed: parcel.awb"))).toBe(false);
    expect(isTransientDbError(Object.assign(new Error("nope"), { code: "BAD_REQUEST" }))).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
  });
});

describe("withRequestId transient retry", () => {
  test("a read that hits one socket reset succeeds on the re-run", async () => {
    let runs = 0;
    const proc = publicProc.input(z.object({})).handler(() => {
      runs++;
      if (runs === 1) throw turso500();
      return { ok: true };
    });
    expect(await call(proc, {}, ctx())).toEqual({ ok: true });
    expect(runs).toBe(2);
  });

  test("a read that keeps failing gives up after two re-runs", async () => {
    let runs = 0;
    const proc = publicProc.input(z.object({})).handler(() => {
      runs++;
      throw turso500();
    });
    await expect(call(proc, {}, ctx())).rejects.toThrow("Failed query");
    expect(runs).toBe(3);
  });

  test("a request that reached a write path is never replayed", async () => {
    let runs = 0;
    const proc = publicProc.input(z.object({})).handler(() => {
      runs++;
      markWrite();
      throw turso500();
    });
    await expect(call(proc, {}, ctx())).rejects.toThrow("Failed query");
    expect(runs).toBe(1);
  });

  test("a non-network failure is not retried", async () => {
    let runs = 0;
    const proc = publicProc.input(z.object({})).handler(() => {
      runs++;
      throw new Error("UNIQUE constraint failed");
    });
    await expect(call(proc, {}, ctx())).rejects.toThrow("UNIQUE");
    expect(runs).toBe(1);
  });

  test("the write mark does not leak into the next request", async () => {
    let runs = 0;
    const writer = publicProc.input(z.object({})).handler(() => {
      markWrite();
      return 1;
    });
    const reader = publicProc.input(z.object({})).handler(() => {
      runs++;
      if (runs === 1) throw turso500();
      return 2;
    });
    await call(writer, {}, ctx());
    expect(await call(reader, {}, ctx())).toBe(2);
    expect(runs).toBe(2);
  });
});
