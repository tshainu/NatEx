import { Link } from "wouter";
import { ArrowRight, CheckCircle2, AlertTriangle } from "lucide-react";
import { apiMessage } from "@/lib/api";
import { date, dateTime, money } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Page, Card, ErrorNote } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { useAlertCounts, useInvariantRuns, useReconciliation, useStale } from "@/queries/cod";
import { useArAgeing, useCurrentPeriod, useSettlementDue } from "@/queries/finance";
import { useDisputeCounts } from "@/queries/disputes";
import { StatusBadge } from "./shared";

/**
 * Finance dashboard (§10 M4 "Finance portal: dashboard").
 *
 * Every figure here is read from the ledger's own totals — nothing is summed
 * from a page of rows in the browser. The four-way strip is §8's
 * "collected vs deposited vs banked vs settled, with variance highlighted at
 * each stage"; each gap is money that has not yet moved to the next stage,
 * which is not automatically an error, so the controls card says which gaps
 * are stale.
 */
export default function FinanceOverview() {
  const recon = useReconciliation();
  const alerts = useAlertCounts();
  const stale = useStale();
  const runs = useInvariantRuns(1);
  const disputes = useDisputeCounts();
  const ar = useArAgeing();
  const due = useSettlementDue();
  const period = useCurrentPeriod();

  const r = recon.data;
  const latest = runs.data?.[0];
  const dueRows = due.data ?? [];
  const dueGross = dueRows.reduce((sum, row) => sum + row.grossCents, 0);
  const error = recon.error ?? alerts.error ?? disputes.error ?? ar.error;

  return (
    <Page
      title="Finance"
      description="Where the cash is, what is owed, and what needs a decision. Every figure is the ledger's own total, refreshed every 15 seconds."
      actions={
        period.data ? (
          <Badge variant="outline">
            Period {date(period.data.periodStart)} – {date(period.data.periodEnd)} · payout {date(period.data.payoutDate)}
          </Badge>
        ) : null
      }
    >
      {error ? <ErrorNote>{apiMessage(error, "Some finance figures could not be loaded.")}</ErrorNote> : null}

      <section aria-labelledby="four-way" className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 id="four-way" className="text-[13px] font-semibold">
            Four-way reconciliation
          </h2>
          {r ? (
            r.ledgerSumCents === 0 ? (
              <Badge variant="good">
                <CheckCircle2 className="size-3" aria-hidden /> Ledger balanced · {r.liveEntryCount} live entries
              </Badge>
            ) : (
              <Badge variant="bad">
                <AlertTriangle className="size-3" aria-hidden /> Ledger out by {money(r.ledgerSumCents)}
              </Badge>
            )
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricTile label="1 · Collected" value={r ? money(r.collectedCents) : "—"} hint="From consignees" />
          <MetricTile
            label="2 · Deposited"
            value={r ? money(r.depositedCents) : "—"}
            hint={r ? `${money(r.inRiderHandsCents)} still with riders` : undefined}
          />
          <MetricTile
            label="3 · Banked"
            value={r ? money(r.bankedCents) : "—"}
            hint={r ? `${money(r.inBranchSafeCents)} in branch safes` : undefined}
          />
          <MetricTile
            label="4 · Settled"
            value={r ? money(r.settledCents) : "—"}
            hint={r ? `${money(r.awaitingSettlementCents)} awaiting settlement` : undefined}
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card
          title="Controls"
          description="§8 controls that need a person."
          actions={<QuickLink to="/finance/alerts" label="Alerts" />}
        >
          <ul className="space-y-2.5 text-[13px]">
            <Row label="Open alerts" value={alerts.data?.open ?? "—"} tone={(alerts.data?.highOpen ?? 0) > 0 ? "bad" : undefined} hint={alerts.data ? `${alerts.data.highOpen} high severity` : undefined} />
            <Row label="Acknowledged, not resolved" value={alerts.data?.acknowledged ?? "—"} />
            <Row label="Stale collections (no deposit)" value={stale.data?.length ?? "—"} tone={(stale.data?.length ?? 0) > 0 ? "bad" : undefined} />
            <Row label="Open cash variance" value={r ? money(r.openVarianceCents) : "—"} tone={r && r.openVarianceCents !== 0 ? "bad" : undefined} />
          </ul>
          <div className="mt-4 border-t pt-3">
            <p className="label-xs text-muted-foreground">Balance invariant · latest run</p>
            {latest ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px]">
                <StatusBadge status={latest.result} />
                <span className="font-mono text-[12px]">{dateTime(latest.ranAt)}</span>
                <Badge variant="outline">{latest.trigger}</Badge>
                <span className="text-muted-foreground">
                  {latest.ridersChecked} riders · {latest.breachCount} breach{latest.breachCount === 1 ? "" : "es"}
                </span>
              </div>
            ) : (
              <p className="mt-1.5 text-[13px] text-muted-foreground">
                {runs.isPending ? "Loading…" : "No run recorded yet."}
              </p>
            )}
          </div>
        </Card>

        <Card
          title="Settlements"
          description="Merchants with banked COD in this period and no run yet."
          actions={<QuickLink to="/finance/remittances" label="Remittances" />}
        >
          <ul className="space-y-2.5 text-[13px]">
            <Row label="Merchants due" value={due.data ? dueRows.length : "—"} />
            <Row label="Gross due" value={due.data ? money(dueGross) : "—"} />
            <Row label="Parcels due" value={due.data ? dueRows.reduce((s, x) => s + x.parcelCount, 0) : "—"} />
          </ul>
          <p className="mt-4 border-t pt-3 text-[12px] leading-relaxed text-muted-foreground">
            A run is a proposal until a second person approves it — the maker can never approve their own (§8).
          </p>
        </Card>

        <Card
          title="Disputes & claims"
          description="Cases waiting on finance."
          actions={<QuickLink to="/finance/disputes" label="Disputes" />}
        >
          <ul className="space-y-2.5 text-[13px]">
            <Row label="Open" value={disputes.data?.open ?? "—"} />
            <Row label="Investigating" value={disputes.data?.investigating ?? "—"} />
            <Row label="Past SLA" value={disputes.data?.overdue ?? "—"} tone={(disputes.data?.overdue ?? 0) > 0 ? "bad" : undefined} />
            <Row label="Claims live in register" value={disputes.data?.register.live ?? "—"} hint={disputes.data ? `${money(disputes.data.register.claimedCents)} claimed` : undefined} />
          </ul>
        </Card>
      </div>

      <Card
        title="Receivables"
        description={`Invoiced charges outstanding, aged from due date${ar.data ? ` (credit term ${ar.data.creditTermDays} days)` : ""}.`}
        actions={<QuickLink to="/finance/invoices?tab=ageing" label="AR ageing" />}
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
          <MetricTile label="Outstanding" value={ar.data ? money(ar.data.outstandingCents) : "—"} />
          <MetricTile label="Not yet due" value={ar.data ? money(ar.data.notYetDueCents) : "—"} />
          {(["0-30", "31-60", "61-90", "90+"] as const).map((bucket) => (
            <MetricTile
              key={bucket}
              label={`${bucket} days`}
              value={ar.data ? money(ar.data.totals[bucket]) : "—"}
            />
          ))}
        </div>
      </Card>
    </Page>
  );
}

function Row({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "bad";
  hint?: string;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">
        {label}
        {hint ? <span className="ml-1.5 text-[11px]">· {hint}</span> : null}
      </span>
      <span className={`font-mono font-medium ${tone === "bad" ? "text-status-bad" : ""}`}>{value}</span>
    </li>
  );
}

function QuickLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      href={to}
      className="inline-flex items-center gap-1 rounded text-[12px] font-medium text-brand-ink hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand/40"
    >
      {label}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}
