import { describe, expect, test } from "bun:test";
import { base32Decode, base32Encode, hotp, matchTotp, newTotpSecret, otpauthUri, stepAt, totpAt } from "./totp";
import { open, seal } from "./secret-box";

// RFC 6238 Appendix B test secret: ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));

describe("TOTP (RFC 6238)", () => {
  test("RFC 4226 Appendix D HOTP vectors", async () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    for (let i = 0; i < expected.length; i += 1) expect(await hotp(RFC_SECRET, i)).toBe(expected[i]!);
  });

  test("RFC 6238 Appendix B SHA-1 vectors (last 6 digits)", async () => {
    const vectors: [number, string][] = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ];
    for (const [t, code] of vectors) expect(await totpAt(RFC_SECRET, stepAt(t * 1000))).toBe(code);
  });

  test("base32 round-trips", () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
  });

  test("accepts ±1 step, refuses replay and wrong codes", async () => {
    const now = 1_790_000_000_000;
    const step = stepAt(now);
    const current = await totpAt(RFC_SECRET, step);
    expect(await matchTotp(RFC_SECRET, current, 0, now)).toEqual({ step });
    expect(await matchTotp(RFC_SECRET, await totpAt(RFC_SECRET, step - 1), 0, now)).toEqual({ step: step - 1 });
    expect(await matchTotp(RFC_SECRET, await totpAt(RFC_SECRET, step + 1), 0, now)).toEqual({ step: step + 1 });
    expect(await matchTotp(RFC_SECRET, await totpAt(RFC_SECRET, step - 2), 0, now)).toBeNull();
    // Same code again after it was accepted → replay, never a second success.
    expect(await matchTotp(RFC_SECRET, current, step, now)).toEqual({ replay: true });
    expect(await matchTotp(RFC_SECRET, "12345", 0, now)).toBeNull();
    expect(await matchTotp(RFC_SECRET, "abcdef", 0, now)).toBeNull();
  });

  test("otpauth URI carries the default parameters", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "+94773456789");
    expect(uri).toContain("otpauth://totp/NatEx%3A%2B94773456789?");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("period=30");
  });
});

describe("secret-box", () => {
  test("seal/open round-trip with a fresh IV each time", async () => {
    const a = await seal("JBSWY3DPEHPK3PXP");
    const b = await seal("JBSWY3DPEHPK3PXP");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(await open(a)).toBe("JBSWY3DPEHPK3PXP");
  });

  test("tampering is detected", async () => {
    const sealed = await seal("secret");
    const [v, iv, ct] = sealed.split(".");
    const flipped = `${v}.${iv}.${ct!.slice(0, -2)}${ct!.endsWith("A") ? "B" : "A"}${ct!.slice(-1)}`;
    await expect(open(flipped)).rejects.toThrow();
  });
});
