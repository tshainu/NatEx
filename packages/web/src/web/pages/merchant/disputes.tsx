import { amount } from "@/lib/format";
import { Page } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { useDisputeCounts } from "@/queries/disputes";
import { DisputeList } from "../disputes/shared";

/**
 * /merchant/disputes — a merchant raises and follows their own disputes and
 * claims (§8, §10 M4). The server scopes every row to this merchant (§5); the
 * merchant may open a case and withdraw it, never decide it.
 */
export default function MerchantDisputes() {
  const counts = useDisputeCounts();
  const c = counts.data;

  return (
    <Page
      title="Disputes & claims"
      description="Raise a dispute about a charge, a short COD remittance, or a lost or damaged parcel, and follow it to a decision."
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile label="Open" value={c ? c.open : "—"} hint="Waiting for NatEx finance" />
        <MetricTile label="Investigating" value={c ? c.investigating : "—"} />
        <MetricTile label="Claimed" value={c ? amount(c.register.claimedCents) : "—"} />
        <MetricTile label="Approved" value={c ? amount(c.register.approvedCents) : "—"} />
      </div>
      <DisputeList mode="merchant" view="all" />
    </Page>
  );
}
