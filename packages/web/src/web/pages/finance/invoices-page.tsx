import { Page } from "@/components/natex/page";
import { TabStrip, useTabParam } from "@/components/natex/tab-strip";
import { ArAgeingTab, InvoicesTab } from "./invoices";

/**
 * /finance/invoices — what merchants owe NatEx (§8, §10 M4): invoices, credit
 * notes, payments, and the receivables ageing that ranks who to chase.
 */

const TABS = ["invoices", "ageing"] as const;

export default function FinanceInvoices() {
  const [tab, setTab] = useTabParam("tab", TABS, "invoices");

  return (
    <Page
      title="Invoices"
      description="Freight and service invoices, credit notes and payments received, and accounts-receivable ageing by merchant."
    >
      <TabStrip
        label="Invoice sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "invoices", label: "Invoices" },
          { id: "ageing", label: "AR ageing" },
        ]}
      />
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "invoices" ? <InvoicesTab /> : <ArAgeingTab />}
      </div>
    </Page>
  );
}
