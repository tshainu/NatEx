import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, Search } from "lucide-react";
import { apiMessage, orpc } from "@/lib/api";
import { since } from "@/lib/format";
import { Page, Card, ErrorNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { ParcelDrawer } from "@/components/natex/parcel-drawer";
import { StatusPill } from "@/components/natex/status-pill";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";

/**
 * /merchant/tracking. Two views of the same parcel:
 *
 *  - The merchant's own view — full custody timeline in the parcel drawer,
 *    looked up by AWB under §5 scope (another merchant's AWB reads "not found").
 *  - The consignee's view — the public `/track/:awb` page, which shows only a
 *    coarse status, locality and timestamps (PDPA, §9). The merchant copies
 *    that link to send to their customer.
 *
 * Below, the parcels that are on the road right now, server-paginated.
 */

const MOVING = ["PickedUp", "AtOriginHub", "Bagged", "InTransit", "AtDestHub", "OutForDelivery", "DeliveryAttempted", "OnHold"];

interface Row {
  id: string;
  awb: string;
  status: string;
  consigneeName: string;
  destAddress: string;
  updatedAt?: string | Date;
  createdAt: string | Date;
}

export default function MerchantTracking() {
  const [awb, setAwb] = React.useState("");
  const [lookup, setLookup] = React.useState<string | null>(null);
  const [openAwb, setOpenAwb] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);

  const found = useQuery({
    ...orpc.parcels.get.queryOptions({ input: { awbOrId: lookup ?? "" } }),
    enabled: lookup !== null,
    retry: false,
  });
  const moving = useQuery({
    ...orpc.parcels.list.queryOptions({ input: { page, pageSize: 25, status: MOVING } }),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });

  const publicUrl = (a: string) => `${window.location.origin}/track/${a}`;
  const copy = async (a: string) => {
    await navigator.clipboard.writeText(publicUrl(a)).catch(() => undefined);
    setCopied(a);
  };

  const columns: Column<Row>[] = [
    { key: "awb", header: "AWB", width: "w-[150px]", cell: (r) => <MonoCell>{r.awb}</MonoCell> },
    { key: "status", header: "Status", width: "w-[160px]", cell: (r) => <StatusPill status={r.status} /> },
    { key: "consignee", header: "Consignee", cell: (r) => r.consigneeName },
    {
      key: "dest",
      header: "Destination",
      cell: (r) => <span className="truncate text-muted-foreground">{r.destAddress}</span>,
    },
    {
      key: "age",
      header: "Booked",
      align: "right",
      width: "w-[110px]",
      className: "font-mono text-muted-foreground",
      cell: (r) => since(r.createdAt),
    },
    {
      key: "link",
      header: <span className="sr-only">Tracking link</span>,
      align: "right",
      width: "w-[130px]",
      cell: (r) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            void copy(r.awb);
          }}
          aria-label={`Copy tracking link for ${r.awb}`}
        >
          <Copy aria-hidden />
          {copied === r.awb ? "Copied" : "Link"}
        </Button>
      ),
    },
  ];

  const detail = found.data;

  return (
    <Page
      title="Tracking"
      description="Look up any of your parcels, and copy the public tracking link to send to your customer."
      bleed
    >
      <Card>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const v = awb.trim().toUpperCase();
            if (v.length >= 3) setLookup(v);
          }}
        >
          <Field label="AWB" className="w-72">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={awb} onChange={(e) => setAwb(e.target.value)} placeholder="NX…" className="pl-8 font-mono" />
            </div>
          </Field>
          <Button type="submit" pending={found.isFetching}>
            Find
          </Button>
        </form>
        {lookup && found.error ? (
          <ErrorNote className="mt-3">{apiMessage(found.error, `${lookup} was not found on your account.`)}</ErrorNote>
        ) : null}
        {detail ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border px-4 py-3" data-testid="lookup-result">
            <span className="font-mono text-[15px] font-medium">{detail.parcel.awb}</span>
            <StatusPill status={detail.parcel.status} />
            <span className="text-[13px] text-muted-foreground">{detail.parcel.consigneeName}</span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setOpenAwb(detail.parcel.awb)}>
                Full timeline
              </Button>
              <Button size="sm" variant="outline" onClick={() => void copy(detail.parcel.awb)}>
                <Copy aria-hidden />
                {copied === detail.parcel.awb ? "Copied" : "Copy customer link"}
              </Button>
              <Button asChild size="sm" variant="ghost">
                <a href={publicUrl(detail.parcel.awb)} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden />
                  What the customer sees
                </a>
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <DataTable
        columns={columns}
        rows={(moving.data?.rows ?? []) as unknown as Row[]}
        rowKey={(r) => r.id}
        loading={moving.isLoading}
        error={moving.error ? apiMessage(moving.error, "Moving parcels are unavailable.") : null}
        onRowClick={(r) => setOpenAwb(r.awb)}
        emptyTitle="Nothing on the road"
        emptyDescription="Parcels appear here from pickup until delivery or return."
        filters={<p className="self-end text-[13px] font-medium">On the road now</p>}
        pagination={{
          page: moving.data?.page ?? page,
          pageSize: moving.data?.pageSize ?? 25,
          total: moving.data?.total ?? 0,
          onPageChange: setPage,
        }}
        className="min-h-0 flex-1"
      />
      <ParcelDrawer awb={openAwb} onOpenChange={(o) => !o && setOpenAwb(null)} />
    </Page>
  );
}
