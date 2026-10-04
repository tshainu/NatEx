import { z } from "zod";
import { adminProc } from "../middleware/pipeline";
import * as parcelsService from "../modules/parcels/service";
import * as codService from "../modules/cod/service";
import { alertCounts } from "../modules/cod/alerts";
import { disputeCounts } from "../modules/cod/disputes";
import { transportCounts } from "../modules/transport/service";
import { deliveryCounts } from "../modules/delivery/service";
import { ndrCounts } from "../modules/delivery/ndr";
import { listBranches, listUsers, sessionCounts } from "../modules/identity/service";
import { merchantNames, merchantStatusCounts } from "../modules/merchants/service";

/**
 * Admin company dashboard (Round 6). One read that answers "how is the whole
 * company doing right now": volume, outcomes, branches, merchants, cash, field
 * operations and people.
 *
 * Composition only — every figure comes from the owning module's exported
 * service function (§4: no module reads another module's tables), and every
 * one is aggregated server-side, never summed in the browser from a page of
 * rows. Admin only: it is network-wide by definition.
 */
export const company = adminProc
  .input(z.object({ days: z.number().int().min(7).max(90).default(30) }))
  .handler(async ({ input, context }) => {
    const scope = context.principal;
    const [
      summary,
      trends,
      branchRows,
      branches,
      top,
      cash,
      flow,
      transport,
      delivery,
      ndr,
      alerts,
      disputes,
      users,
      sessions,
      merchantStatus,
    ] = await Promise.all([
      parcelsService.parcelSummary(scope),
      parcelsService.parcelTrends(scope, input.days),
      parcelsService.branchSplit(),
      listBranches(),
      parcelsService.topMerchants(input.days, 8),
      codService.reconciliation(),
      codService.dailyFlow(input.days),
      transportCounts(scope),
      deliveryCounts(scope),
      ndrCounts(scope),
      alertCounts(),
      disputeCounts(),
      listUsers(scope),
      sessionCounts(),
      merchantStatusCounts(),
    ]);

    const names = new Map((await merchantNames(top.map((t) => t.merchantId))).map((m) => [m.id, m.name]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    const byRole = new Map<string, { role: string; active: number; suspended: number }>();
    for (const u of users) {
      const row = byRole.get(u.role) ?? { role: u.role, active: 0, suspended: 0 };
      if (u.status === "active") row.active += 1;
      else row.suspended += 1;
      byRole.set(u.role, row);
    }
    const signedIn = new Set(sessions.filter((s) => s.activeSessions > 0).map((s) => s.userId));

    return {
      days: input.days,
      summary,
      trends,
      branches: branchRows
        .map((b) => ({ ...b, name: branchName.get(b.branchId) ?? b.branchId }))
        .sort((a, z) => z.open + z.closed - (a.open + a.closed)),
      topMerchants: top.map((t) => ({ ...t, name: names.get(t.merchantId) ?? t.merchantId })),
      cash: {
        collectedCents: cash.collectedCents,
        depositedCents: cash.depositedCents,
        bankedCents: cash.bankedCents,
        settledCents: cash.settledCents,
        inRiderHandsCents: cash.inRiderHandsCents,
        inBranchSafeCents: cash.inBranchSafeCents,
        awaitingSettlementCents: cash.awaitingSettlementCents,
        openVarianceCents: cash.openVarianceCents,
        ledgerSumCents: cash.ledgerSumCents,
      },
      flow,
      transport,
      delivery,
      ndr,
      alerts: { open: alerts.open, acknowledged: alerts.acknowledged, highOpen: alerts.highOpen },
      disputes: { open: disputes.open, investigating: disputes.investigating, overdue: disputes.overdue },
      people: {
        byRole: [...byRole.values()].sort((a, z) => z.active + z.suspended - (a.active + a.suspended)),
        total: users.length,
        signedIn: users.filter((u) => signedIn.has(u.id)).length,
      },
      merchants: merchantStatus,
      generatedAt: new Date().toISOString(),
    };
  });

/** Router namespace — composed into the root router in api/index.ts. */
export const dashboard = { company };
