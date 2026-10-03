import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { readiness } from "./readiness";
import { stopWorker } from "../jobs/worker";
import { stopNightly } from "../jobs/nightly";

// The worker and nightly timers only start when src/api/index.ts loads, which
// this test never imports — so this is the "server up, background jobs dead"
// case an uptime monitor must catch.
describe("GET /api/health/ready", () => {
  test("503 with states only when the background jobs are not running", async () => {
    stopWorker();
    stopNightly();
    const app = new Hono().get("/ready", readiness);
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, string>;
    expect(body.status).toBe("down");
    expect(body.db).toBe("ok");
    expect(body.worker).toBe("stopped");
    expect(body.nightly).toBe("stopped");
    expect(Object.keys(body).sort()).toEqual(["checkedAt", "db", "nightly", "status", "worker"]);
  });
});
