import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const databaseUrl = `file:${join(tmpdir(), `natex-arrival-${randomUUID()}.db`)}`;
process.env.DATABASE_URL = databaseUrl;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.NODE_ENV = "test";

const { calculateArrivalAmounts, isFinalDeliveryHub } = await import("./service");

describe("destination-arrival notice rules", () => {
  test("matches only the configured final delivery branch", () => {
    expect(isFinalDeliveryHub("branch-jaffna", "branch-jaffna")).toBe(true);
    expect(isFinalDeliveryHub("branch-colombo", "branch-jaffna")).toBe(false);
    expect(isFinalDeliveryHub(null, "branch-jaffna")).toBe(false);
    expect(isFinalDeliveryHub(undefined, "branch-jaffna")).toBe(false);
  });

  test("adds only unpaid recipient freight to COD", () => {
    expect(calculateArrivalAmounts(
      480_000,
      { payer: "recipient", amountCents: 100_000 },
      [{ amountCents: 20_000 }],
    )).toEqual({
      codAmountCents: 480_000,
      recipientFreightDueCents: 80_000,
      amountDueCents: 560_000,
    });
    expect(calculateArrivalAmounts(
      480_000,
      { payer: "sender", amountCents: 100_000 },
      [],
    )).toEqual({
      codAmountCents: 480_000,
      recipientFreightDueCents: 0,
      amountDueCents: 480_000,
    });
  });

  test("clamps negative COD and already-paid freight so the customer is not overcharged", () => {
    expect(calculateArrivalAmounts(
      -1,
      { payer: "recipient", amountCents: 100 },
      [{ amountCents: 150 }],
    )).toEqual({
      codAmountCents: 0,
      recipientFreightDueCents: 0,
      amountDueCents: 0,
    });
  });
});
