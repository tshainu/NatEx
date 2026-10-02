import { eq, inArray, like, or } from "drizzle-orm";

/**
 * Wipe one FIXTURE merchant's money rows so a script can re-run from a clean
 * slate without touching seeded or probe data. Never point this at a seeded
 * merchant.
 *
 * The unit of deletion is the deposit chain, not the merchant row: a COLLECT
 * carries merchantId, but the DEPOSIT and BANK postings it rolls into carry
 * merchantId NULL (they are rider- and branch-level). Deleting only the
 * merchant-tagged half would leave orphan DEPOSITs and push the rider's
 * liability (Σ COLLECT − Σ DEPOSIT) negative, which §8 calls impossible and
 * which breaks the nightly invariant for everyone sharing the rider. A deposit
 * that also carries another merchant's cash is left alone and reported.
 *
 * Same logic as smoke-m4's section 0, factored out for the UI proofs.
 */
export async function resetMerchantMoney(merchantId: string, sourceKeyPrefix: string): Promise<{ sharedDeposits: string[] }> {
  const { db } = await import("../../src/api/database");
  const cod = await import("../../src/api/database/schema/cod");

  const priorEntries = await db
    .select({ id: cod.codEntry.id, depositId: cod.codEntry.depositId })
    .from(cod.codEntry)
    .where(eq(cod.codEntry.merchantId, merchantId));
  const priorEntryIds = priorEntries.map((r) => r.id);
  const shared: string[] = [];
  if (priorEntryIds.length) {
    const items = await db
      .select({ depositId: cod.codDepositItem.depositId })
      .from(cod.codDepositItem)
      .where(inArray(cod.codDepositItem.entryId, priorEntryIds));
    const candidates = [
      ...new Set([
        ...items.map((i) => i.depositId),
        ...priorEntries.map((e) => e.depositId).filter((d): d is string => Boolean(d)),
      ]),
    ];
    const mine: string[] = [];
    for (const depositId of candidates) {
      const attached = await db
        .select({ merchantId: cod.codEntry.merchantId })
        .from(cod.codEntry)
        .where(eq(cod.codEntry.depositId, depositId));
      const foreign = attached.some((a) => a.merchantId !== null && a.merchantId !== merchantId);
      (foreign ? shared : mine).push(depositId);
    }
    if (mine.length) {
      await db.delete(cod.codEntry).where(inArray(cod.codEntry.depositId, mine));
      await db.delete(cod.codDepositItem).where(inArray(cod.codDepositItem.depositId, mine));
      await db.delete(cod.codOpsAlert).where(inArray(cod.codOpsAlert.depositId, mine));
      await db.delete(cod.codHold).where(inArray(cod.codHold.depositId, mine));
      await db.delete(cod.codDeposit).where(inArray(cod.codDeposit.id, mine));
    }
    await db.delete(cod.codDepositItem).where(inArray(cod.codDepositItem.entryId, priorEntryIds));
  }

  const settlements = await db
    .select({ id: cod.codSettlement.id })
    .from(cod.codSettlement)
    .where(eq(cod.codSettlement.merchantId, merchantId));
  if (settlements.length) {
    const ids = settlements.map((r) => r.id);
    await db.delete(cod.codOpsAlert).where(inArray(cod.codOpsAlert.settlementId, ids));
    await db.delete(cod.codSettlementLine).where(inArray(cod.codSettlementLine.settlementId, ids));
    await db.delete(cod.codSettlement).where(inArray(cod.codSettlement.id, ids));
  }
  const invoices = await db
    .select({ id: cod.codInvoice.id })
    .from(cod.codInvoice)
    .where(eq(cod.codInvoice.merchantId, merchantId));
  if (invoices.length) {
    const ids = invoices.map((r) => r.id);
    await db.delete(cod.codInvoiceLine).where(inArray(cod.codInvoiceLine.invoiceId, ids));
    await db.delete(cod.codCreditNote).where(inArray(cod.codCreditNote.invoiceId, ids));
    await db.delete(cod.codInvoice).where(inArray(cod.codInvoice.id, ids));
  }
  await db.delete(cod.codEntry).where(eq(cod.codEntry.merchantId, merchantId));
  await db.delete(cod.codHold).where(eq(cod.codHold.merchantId, merchantId));
  await db.delete(cod.codMerchantPayout).where(eq(cod.codMerchantPayout.merchantId, merchantId));
  await db
    .delete(cod.codOpsAlert)
    .where(or(eq(cod.codOpsAlert.merchantId, merchantId), like(cod.codOpsAlert.sourceKey, `${sourceKeyPrefix}%`)));
  return { sharedDeposits: shared };
}
