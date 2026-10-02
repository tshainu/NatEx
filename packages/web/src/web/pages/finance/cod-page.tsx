import { Page } from "@/components/natex/page";
import { TabStrip, useTabParam } from "@/components/natex/tab-strip";
import { useAlertCounts } from "@/queries/cod";
import { LedgerTab, ReconciliationTab } from "./cod-ledger";
import { DepositsTab, RiderCashTab } from "./cod-cash";
import { AlertsTab, ConfigTab, InvariantTab } from "./controls";

/**
 * /finance/cod — the COD money path end to end (§8, §10 M4).
 *
 * One page, seven tabs, in the order the cash moves: the ledger itself, the
 * four-way reconciliation, who is holding cash, branch deposits and banking,
 * then the controls that watch all of it (nightly invariant, alerts, limits).
 * `?tab=` is mirrored so the overview's links land on the right tab.
 */

const TABS = ["ledger", "recon", "riders", "deposits", "invariant", "alerts", "config"] as const;

export default function FinanceCod() {
  const [tab, setTab] = useTabParam("tab", TABS, "ledger");
  const alerts = useAlertCounts();

  return (
    <Page
      title="COD ledger"
      description="Every rupee collected on delivery, from the rider's hand to the bank, as double-entry ledger lines. Nothing here is edited in place — corrections are reversing entries."
    >
      <TabStrip
        label="COD ledger sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "ledger", label: "Ledger" },
          { id: "recon", label: "Reconciliation" },
          { id: "riders", label: "Rider cash" },
          { id: "deposits", label: "Deposits" },
          { id: "invariant", label: "Invariant" },
          { id: "alerts", label: "Alerts", badge: alerts.data ? alerts.data.open : undefined },
          { id: "config", label: "Limits" },
        ]}
      />
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "ledger" ? <LedgerTab /> : null}
        {tab === "recon" ? <ReconciliationTab /> : null}
        {tab === "riders" ? <RiderCashTab /> : null}
        {tab === "deposits" ? <DepositsTab /> : null}
        {tab === "invariant" ? <InvariantTab /> : null}
        {tab === "alerts" ? <AlertsTab /> : null}
        {tab === "config" ? <ConfigTab /> : null}
      </div>
    </Page>
  );
}
