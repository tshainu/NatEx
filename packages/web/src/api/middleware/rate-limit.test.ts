import { describe, expect, test } from "bun:test";
import { clientIp } from "./rate-limit";

const h = (init: Record<string, string>) => new Headers(init);

describe("clientIp (M5 security review)", () => {
  test("the edge's own headers win over anything in X-Forwarded-For", () => {
    expect(clientIp(h({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.1.1.1" }))).toBe("203.0.113.7");
    expect(clientIp(h({ "x-real-ip": "203.0.113.8", "x-forwarded-for": "1.1.1.1" }))).toBe("203.0.113.8");
  });

  test("a client-typed leftmost X-Forwarded-For entry is ignored; the proxy-appended rightmost one is used", () => {
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(h({ "x-forwarded-for": "9.9.9.9, 6.6.6.6 , 198.51.100.4" }))).toBe("198.51.100.4");
  });

  test("rotating the spoofable part does not change the bucket key", () => {
    const keys = new Set(
      Array.from({ length: 20 }, (_, i) => clientIp(h({ "x-real-ip": "203.0.113.9", "x-forwarded-for": `10.0.0.${i}` }))),
    );
    expect(keys.size).toBe(1);
  });

  test("no address at all collapses to one shared bucket, never a fresh one", () => {
    expect(clientIp(h({}))).toBe("unknown");
    expect(clientIp(h({ "x-forwarded-for": " , " }))).toBe("unknown");
  });
});
