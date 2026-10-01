import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { client, orpc, apiMessage } from "@/lib/api";
import { amount, colomboToday, date, grams, humanise } from "@/lib/format";
import { BOARD_ORDER } from "@/lib/status";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { StatusPill } from "@/components/natex/status-pill";
import { ParcelDrawer } from "@/components/natex/parcel-drawer";
import { ExportCsvButton } from "@/components/natex/export-csv";
import { useDebounced } from "@/lib/hooks";
import { centsToRupees } from "@/lib/csv";

/**
 * Merchant parcel list. Identical query to the ops register — the server scopes
 * it to this merchant's own rows (§5), so nothing here filters by merchant id
 * and nothing here could widen the scope if it tried.
 *
 * The detail drawer is the same component ops uses: it renders only the
 * transitions the server reports as `commandable`, which for a merchant is
 * none. A merchant reads custody; it does not move it. Failed deliveries are
 * answered on the NDR screen, not here.
 */

interface Row {
  id: string;
  awb: string;
  status: string;
  consigneeName: string;
  consigneePhone: string;
  destAddress: string;
  weightGrams: number;
  codAmountCents: number;
  createdAt: string | Date;
}

export default function MerchantParcels() {
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState(
    () => new URLSearchParams(window.location.search).get("status") ?? "",
  );
  const [page, setPage] = React.useState(1);
  const [openAwb, setOpenAwb] = React.useState<string | null>(null);

  const debounced = useDebounced(search, 250);
  React.useEffect(() => setPage(1), [debounced, status]);

  const filter = {
    search: debounced.trim() || undefined,
    status: status ? [status] : undefined,
  };
  const list = useQuery({
    ...orpc.parcels.list.queryOptions({ input: { ...filter, page, pageSize: 25 } }),
    placeholderData: (prev) => prev,
  });

  const columns: Column<Row>[] = [
    { key: "awb", header: "AWB", width: "w-[150px]", cell: (r) => <MonoCell>{r.awb}</MonoCell> },
    {
      key: "status",
      header: "Status",
      width: "w-[150px]",
      cell: (r) => <StatusPill status={r.status} />,
    },
    {
      key: "consignee",
      header: "Consignee",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate">{r.consigneeName}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {r.consigneePhone}
          </p>
        </div>
      ),
    },
    {
      key: "dest",
      header: "Destination",
      cell: (r) => <span className="truncate text-muted-foreground">{r.destAddress}</span>,
    },
    {
      key: "weight",
      header: "Weight",
      align: "right",
      width: "w-[90px]",
      className: "font-mono text-muted-foreground",
      cell: (r) => grams(r.weightGrams),
    },
    {
      key: "cod",
      header: "COD (Rs.)",
      align: "right",
      width: "w-[110px]",
      className: "font-mono",
      cell: (r) =>
        r.codAmountCents > 0 ? (
          amount(r.codAmountCents)
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "booked",
      header: "Booked",
      align: "right",
      width: "w-[110px]",
      className: "font-mono text-muted-foreground",
      cell: (r) => date(r.createdAt),
    },
  ];

  return (
    <Page
      title="Shipments"
      description="Every parcel booked against your account. Click a row for the full custody timeline, exactly as NatEx operations sees it."
      bleed
    >
      <DataTable
        columns={columns}
        rows={(list.data?.rows ?? []) as unknown as Row[]}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error ? apiMessage(list.error, "Your parcel list is unavailable.") : null}
        onRowClick={(r) => setOpenAwb(r.awb)}
        emptyTitle="No parcel matches this filter"
        emptyDescription="Search matches AWB, consignee name and consignee phone. New parcels are booked under Book parcels."
        filters={
          <>
            <Field label="Search" className="w-72">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="AWB, consignee or phone"
                  className="pl-8 font-mono text-[13px]"
                />
              </div>
            </Field>
            <Field label="Status" className="w-52">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                {BOARD_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {humanise(s)}
                  </option>
                ))}
              </Select>
            </Field>
            {search || status ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setStatus("");
                }}
              >
                Reset
              </Button>
            ) : null}
            <div className="ml-auto self-end">
              <ExportCsvButton<Row>
                filename={`shipments-${colomboToday()}.csv`}
                header={["awb", "status", "consignee_name", "consignee_phone", "delivery_address", "weight_g", "cod_rs", "booked_at"]}
                toRow={(r) => [r.awb, r.status, r.consigneeName, r.consigneePhone, r.destAddress, r.weightGrams, centsToRupees(r.codAmountCents), new Date(r.createdAt).toISOString()]}
                fetchPage={async (p) => {
                  const res = await client.parcels.list({ ...filter, page: p, pageSize: 100 });
                  return { ...res, rows: res.rows as unknown as Row[] };
                }}
              />
            </div>
          </>
        }
        pagination={{
          page: list.data?.page ?? page,
          pageSize: list.data?.pageSize ?? 25,
          total: list.data?.total ?? 0,
          onPageChange: setPage,
        }}
        className="min-h-0 flex-1"
      />
      <ParcelDrawer awb={openAwb} onOpenChange={(open) => !open && setOpenAwb(null)} />
    </Page>
  );
}
