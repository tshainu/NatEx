import { money } from "@/lib/format";
import { Page } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { TabStrip, useTabParam } from "@/components/natex/tab-strip";
import { useDisputeCounts } from "@/queries/disputes";
import { DisputeList } from "../disputes/shared";

/**
 * /finance/disputes — the dispute queue and the claim register (§8, §10 M4).
 *
 * The queue is every live case, oldest SLA first; the register is the claims
 * subset (loss, damage, short COD) with what was claimed, approved and paid.
 * Deciding a case is finance-only and never by the person who opened it — the
 * server enforces that, the drawer explains it.
 */

const TABS = ["queue", "register"] as const;

export default function FinanceDisputes() {
  const [tab, setTab] = useTabParam("tab", TABS, "queue");
  const counts = useDisputeCounts();
  const c = counts.data;

  return (
    <Page
      title="Disputes"
      description="Merchant disputes and claims: pick a case up, investigate it, and decide it with a remedy — a credit note against an invoice or a bank transfer."
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricTile label="Open" value={c ? c.open : "—"} hint="Not yet picked up" />
        <MetricTile label="Investigating" value={c ? c.investigating : "—"} />
        <MetricTile label="Past SLA" value={c ? c.overdue : "—"} accent={c && c.overdue > 0 ? "var(--status-bad)" : undefined} />
        <MetricTile label="Claims claimed" value={c ? money(c.register.claimedCents) : "—"} hint={c ? `${c.register.live} live claims` : undefined} />
        <MetricTile
          label="Claims paid"
          value={c ? money(c.register.paidCreditNoteCents + c.register.paidBankCents) : "—"}
          hint={c ? `${money(c.register.paidCreditNoteCents)} credit · ${money(c.register.paidBankCents)} bank` : undefined}
        />
      </div>
      <TabStrip
        label="Dispute views"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "queue", label: "Queue", badge: c ? c.open + c.investigating : undefined },
          { id: "register", label: "Claim register" },
        ]}
      />
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        <DisputeList key={tab} mode="finance" view={tab} />
      </div>
    </Page>
  );
}
