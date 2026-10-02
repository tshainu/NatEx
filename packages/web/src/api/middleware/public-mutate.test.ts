import { describe, expect, mock, test } from "bun:test";
import { call } from "@orpc/server";
import { z } from "zod";
import * as realRateLimit from "./rate-limit";

/**
 * publicMutate × the transient retry (live failure 2026-10-02: a Turso
 * ECONNRESET on the rate-limit bucket insert made `identity.requestOtp` a 500,
 * because the request was marked as written before the bucket was touched).
 */

function turso500(): Error {
  const fetchErr = Object.assign(new Error("request to https://x.turso.io/v2/pipeline failed, reason: read ECONNRESET"), {
    code: "ECONNRESET",
    errno: "ECONNRESET",
  });
  return Object.assign(new Error('Failed query: insert into "shared_rate_limit"'), { cause: fetchErr });
}

let bucketFailures = 0;
let bucketCalls = 0;
// Delegates to the real limiter unless a failure is queued, so any later test
// file that imports rate-limit in this process is unaffected.
mock.module("./rate-limit", () => ({
  ...realRateLimit,
  consumeToken: async (...args: Parameters<typeof realRateLimit.consumeToken>) => {
    if (!args[0].startsWith("anon:test:")) return realRateLimit.consumeToken(...args);
    bucketCalls++;
    if (bucketFailures > 0) {
      bucketFailures--;
      throw turso500();
    }
  },
}));

const { publicMutate, publicProc } = await import("./pipeline");
const ctx = () => ({ context: { headers: new Headers({ "x-forwarded-for": "test" }) } });
const bucket = { capacity: 5, refillPerMinute: 5 };

describe("publicMutate under a dropped database socket", () => {
  test("a reset on the rate-limit bucket is retried, and the handler runs once", async () => {
    bucketFailures = 1;
    bucketCalls = 0;
    let runs = 0;
    const proc = publicProc.input(z.object({})).handler(({ context }) =>
      publicMutate(context, { route: "test.otp", bucket, ipScope: "test" }, async () => {
        runs++;
        return { sent: true };
      }),
    );
    expect(await call(proc, {}, ctx())).toEqual({ sent: true });
    expect(bucketCalls).toBe(2);
    expect(runs).toBe(1);
  });

  test("a reset inside the handler (after the business write began) is never replayed", async () => {
    bucketFailures = 0;
    bucketCalls = 0;
    let runs = 0;
    const proc = publicProc.input(z.object({})).handler(({ context }) =>
      publicMutate(context, { route: "test.otp", bucket, ipScope: "test" }, async () => {
        runs++;
        throw turso500();
      }),
    );
    await expect(call(proc, {}, ctx())).rejects.toThrow("Failed query");
    expect(runs).toBe(1);
  });
});
