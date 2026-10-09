import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { requestFingerprint } from "./idempotency";

const originalAccessSecret = process.env.JWT_ACCESS_SECRET;

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET = "unit-test-secret-not-for-production";
});

afterAll(() => {
  if (originalAccessSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
  else process.env.JWT_ACCESS_SECRET = originalAccessSecret;
});

describe("password-safe idempotency fingerprints", () => {
  test("same payload gets the same fingerprint for safe retries", async () => {
    const input = { portalUser: { username: "merchant-1", password: "Correct Horse Battery!" } };
    expect(await requestFingerprint("merchants.onboard", input)).toBe(
      await requestFingerprint("merchants.onboard", input),
    );
  });

  test("changed passwords still produce a payload mismatch", async () => {
    const first = await requestFingerprint("merchants.onboard", {
      portalUser: { username: "merchant-1", password: "First password" },
    });
    const second = await requestFingerprint("merchants.onboard", {
      portalUser: { username: "merchant-1", password: "Second password" },
    });
    expect(first).not.toBe(second);
  });

  test("fingerprint never contains the submitted password", async () => {
    const password = "A very private merchant password";
    const fingerprint = await requestFingerprint("merchants.onboard", { password });
    expect(fingerprint).not.toContain(password);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
