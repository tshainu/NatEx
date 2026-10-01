import { useQuery } from "@tanstack/react-query";
import { orpc, apiMessage } from "@/lib/api";
import { dateTime, humanise, money } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Page, Card, ErrorNote } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { StatusPill } from "@/components/natex/status-pill";

/**
 * Finance overview, interim. The M4 ledger, settlements, invoices and disputes
 * are built behind the API (scripts/smoke-m4.ts, probe-cod-wiring.ts,
 * probe-disputes.ts) but their screens are not yet. Until the finance
 * dashboard replaces this page it shows only what it can read directly:
 * which merchants carry COD, and COD declared on the newest parcels.
 *
 * Finance is a global-scope role (api/shared/auth.ts), so these figures span
 * every branch.
 */

interface ParcelRow {
  id: string;
  awb: string;
  status: string;
  merchantId: string;
  codAmountCents: number;
  consigneeName: string;
  createdAt: string | Date;
}

export default function FinanceOverview() {
  const merchants = useQuery(
    orpc.merchants.list.queryOptions({ input: { page: 1, pageSize: 100 } }),
  );
  // One page of the newest parcels — a sample, labelled as one, never presented
  // as a settled balance.
  const parcels = useQuery(
    orpc.parcels.list.queryOptions({ input: { page: 1, pageSize: 100 } }),
  );

  const rows = (parcels.data?.rows ?? []) as unknown as ParcelRow[];
  const codRows = rows.filter((r) => r.codAmountCents > 0);
  const sampleCod = codRows.reduce((sum, r) => sum + r.codAmountCents, 0);
  const codMerchants = (merchants.data?.rows ?? []).filter((m) => m.codEnabled);
  const merchantName = (id: string) =>
    merchants.data?.rows.find((m) => m.id === id)?.name ?? "—";

  const columns: Column<ParcelRow>[] = [
    { key: "awb", header: "AWB", width: "w-[160px]", cell: (r) => <MonoCell>{r.awb}</MonoCell> },
    {
      key: "merchant",
      header: "Merchant",
      cell: (r) => <span className="truncate">{merchantName(r.merchantId)}</span>,
    },
    {
      key: "consignee",
      header: "Consignee",
      cell: (r) => <span className="truncate text-muted-foreground">{r.consigneeName}</span>,
    },
    {
      key: "status",
      header: "Custody",
      width: "w-[150px]",
      cell: (r) => <StatusPill status={r.status} />,
    },
    {
      key: "cod",
      header: "COD declared",
      align: "right",
      width: "w-[140px]",
      className: "font-mono font-medium",
      cell: (r) => money(r.codAmountCents),
    },
    {
      key: "booked",
      header: "Booked",
      align: "right",
      width: "w-[150px]",
      className: "font-mono text-muted-foreground",
      cell: (r) => dateTime(r.createdAt),
    },
  ];

  const error =
    parcels.error || merchants.error
      ? apiMessage(parcels.error ?? merchants.error, "Finance data is unavailable.")
      : null;

  return (
    <Page
      title="Finance overview"
      description="Cash-on-delivery exposure as declared at booking. The ledger, reconciliation and settlement screens are next."
      actions={<Badge variant="milestone">Ledger screens in build · M4</Badge>}
    >
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <MetricTile
          label="COD parcels in sample"
          value={codRows.length}
          hint={`of ${rows.length} newest parcels`}
        />
        <MetricTile
          label="COD declared in sample"
          value={money(sampleCod)}
          hint="Declared at booking, not collected"
        />
        <MetricTile
          label="Merchants with COD enabled"
          value={codMerchants.length}
          hint={`of ${merchants.data?.total ?? 0} merchants`}
        />
      </div>

      <Card
        title="What this page does and does not show"
        className="max-w-3xl"
      >
        <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Recorded today.</span> A COD amount
            is captured on the parcel at booking and travels with it through the state machine.
            Every custody change is written to the append-only parcel event log.
          </p>
          <p>
            <span className="font-medium text-foreground">Recorded, not shown here.</span>{" "}
            Collections, rider cash, deposits, settlements, UTRs, invoices and disputes are
            posted to the double-entry COD ledger, but their screens are not built yet. The
            figures above are the sum of what was <span className="italic">declared</span> on
            a sample of parcels, not what was collected, and will not match the ledger.
          </p>
          <p>
            <span className="font-medium text-foreground">Why a sample.</span> This interim
            page sums the page of parcels it can read (100 rows) and says so; the finance
            dashboard will read the ledger&apos;s own totals instead.
          </p>
        </div>
      </Card>

      <Card
        title="COD-enabled merchants"
        description="Merchants permitted to book cash-on-delivery parcels."
        bodyClassName="p-0"
      >
        {codMerchants.length === 0 ? (
          <p className="p-5 text-[13px] text-muted-foreground">
            No merchant currently has COD enabled.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {codMerchants.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{m.name}</p>
                  <p className="truncate text-[12px] text-muted-foreground">
                    {m.contactName} · <span className="font-mono">{m.contactPhone}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline">POD: {humanise(m.podPolicy)}</Badge>
                  <Badge variant={m.status === "active" ? "good" : "warn"}>
                    {m.status === "active" ? "Active" : "Suspended"}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <DataTable
        columns={columns}
        rows={codRows}
        rowKey={(r) => r.id}
        loading={parcels.isLoading}
        emptyTitle="No COD parcel in the newest 100"
        emptyDescription="Prepaid parcels carry a zero COD amount and are excluded here."
      />
    </Page>
  );
}
