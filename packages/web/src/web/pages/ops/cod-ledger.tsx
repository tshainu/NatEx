import { ErrorNote, Page } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { money } from "@/lib/format";
import { useReconciliation } from "@/queries/cod";
import { useAuth } from "@/components/auth-provider";
import { LedgerTab } from "../finance/cod-ledger";

/** Operations sees only entries attributed to its branch and Admin-assigned child branches. */
export default function OpsCodLedger() {
  const { session } = useAuth();
  const isOps = session?.user.role === "ops";
  const summary = useReconciliation();
  const data = summary.data;

  return (
    <Page
      title="COD collections"
      description={isOps
        ? "Read-only view of COD activity for your assigned hub and branches explicitly assigned to that hub by Admin. Finance retains settlement and correction controls."
        : "Administrator read-only view of COD activity across the network. Use Finance → COD ledger for settlement and correction controls."}
    >
      <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
        {isOps
          ? "This view includes only ledger entries with a recorded branch assignment in your scope. Network-level settlement lines without branch attribution remain in Finance and are not included here."
          : "Administrator access is network-wide. Historical entries without a branch assignment may appear here; Operations users are restricted to their assigned hub and Admin-linked branches."}
      </p>
      {summary.isError ? <ErrorNote>The scoped COD summary could not be loaded.</ErrorNote> : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <MetricTile label="Collected" value={data ? money(data.collectedCents) : "—"} />
        <MetricTile label="Still with riders" value={data ? money(data.inRiderHandsCents) : "—"} />
        <MetricTile label="Deposited" value={data ? money(data.depositedCents) : "—"} />
        <MetricTile label="In branch safes" value={data ? money(data.inBranchSafeCents) : "—"} />
        <MetricTile label="Banked" value={data ? money(data.bankedCents) : "—"} />
      </div>
      <LedgerTab branchScoped={isOps} readOnly />
    </Page>
  );
}
