import { Page } from "@/components/natex/page";
import { TabStrip, useTabParam } from "@/components/natex/tab-strip";
import { SettlementsTab } from "./settlements";
import { HoldsTab } from "./holds";
import { BankDetailsTab } from "./bank-details";

/**
 * /finance/remittances — paying merchants their COD (§8, §10 M4).
 *
 * Settlement runs go draft → proposed → approved → paid with maker–checker
 * between proposing and approving (the server refuses the same person doing
 * both; this page only explains the refusal). Holds are the money held back
 * from a run — disputes, chargebacks, risk — and clear on their own tab.
 */

const TABS = ["settlements", "holds", "bank"] as const;

export default function FinanceRemittances() {
  const [tab, setTab] = useTabParam("tab", TABS, "settlements");

  return (
    <Page
      title="Remittances"
      description="Merchant settlement runs, approvals, payout files and bank references, the holds that keep money back from a run, and where each merchant is paid."
    >
      <TabStrip
        label="Remittance sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "settlements", label: "Settlements" },
          { id: "holds", label: "Holds" },
          { id: "bank", label: "Bank details" },
        ]}
      />
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "settlements" ? <SettlementsTab /> : tab === "holds" ? <HoldsTab /> : <BankDetailsTab />}
      </div>
    </Page>
  );
}
