import type { AppRouterClient } from "../../src/api";

/**
 * Hand a rider's undeposited COD back to the branch, along the real §8 chain:
 * the rider declares (checkpoint 2), finance counts it (3a) and banks it (3b).
 *
 * Since recordDelivery started posting a COLLECT entry for every COD delivery,
 * fixture scripts that deliver COD parcels leave cash on the rider. Without
 * this, a few runs push the rider past the Rs. 50,000 ceiling and
 * dispatchRunsheet refuses to send them out. That refusal is correct (§8),
 * so the scripts settle the cash instead of loosening the gate.
 *
 * Returns what was handed over, in cents (0 when the rider held nothing).
 */
const FINANCE_PHONE = "+94774567890";

type ClientFor = (token?: string, idemKey?: string) => AppRouterClient;
type Login = (phone: string) => Promise<{ accessToken: string; user: { name: string } }>;

export async function bankRiderCash(opts: {
  clientFor: ClientFor;
  login: Login;
  riderToken: string;
  branchId: string;
  key: (label: string) => string;
  label: string;
}): Promise<{ depositedCents: number; entries: number }> {
  const { clientFor, riderToken, key, label } = opts;
  const held = await clientFor(riderToken).cod.myUndeposited({});
  if (held.length === 0) return { depositedCents: 0, entries: 0 };
  const total = held.reduce((s, e) => s + e.amountCents, 0);

  const deposit = await clientFor(riderToken, key(`cash-${label}-declare`)).cod.declareDeposit({
    branchId: opts.branchId,
    declaredCents: total,
    entryIds: held.map((e) => e.id),
    note: `fixture cash hand-over (${label})`,
  });
  const finance = await opts.login(FINANCE_PHONE);
  await clientFor(finance.accessToken, key(`cash-${label}-verify`)).cod.verifyDeposit({
    depositId: deposit.id,
    countedCents: total,
  });
  await clientFor(finance.accessToken, key(`cash-${label}-bank`)).cod.bankDeposit({
    depositId: deposit.id,
    bankRef: `FX-${deposit.code}`,
    bankAccount: "BOC 0001-fixture",
  });
  return { depositedCents: total, entries: held.length };
}
