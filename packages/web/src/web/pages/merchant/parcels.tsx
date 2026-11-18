import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { client, apiMessage } from "@/lib/api";
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
import { MerchantAddressLabel } from "@/components/natex/merchant-address-label";
import { useMerchantProfile } from "@/queries/merchant";

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
  destinationBranchName: string | null;
  destinationDistrict: string | null;
  destinationResolutionStatus: string;
  weightGrams: number;
  codAmountCents: number;
  createdAt: string | Date;
}

export default function MerchantParcels() {
  const profile = useMerchantProfile();
  const merchant = profile.data;
  const [search, setSearch] = React.useState("");
  const [createdFrom, setCreatedFrom] = React.useState("");
  const [createdTo, setCreatedTo] = React.useState("");
  const [pageSizeOption, setPageSizeOption] = React.useState<50 | 100 | 500 | "all">(50);
  const [status, setStatus] = React.useState(
    () => new URLSearchParams(window.location.search).get("status") ?? "",
  );
  const [page, setPage] = React.useState(1);
  const [openAwb, setOpenAwb] = React.useState<string | null>(null);

  const debounced = useDebounced(search, 250);
  const dateRangeInvalid = Boolean(createdFrom && createdTo && createdFrom > createdTo);
  React.useEffect(() => setPage(1), [debounced, status, createdFrom, createdTo, pageSizeOption]);

  const filter = {
    search: debounced.trim() || undefined,
    status: status ? [status] : undefined,
    createdFrom: createdFrom || undefined,
    createdTo: createdTo || undefined,
  };
  const list = useQuery({
    queryKey: ["merchant-parcels", filter, page, pageSizeOption],
    queryFn: async () => {
      if (pageSizeOption !== "all") {
        return client.parcels.list({ ...filter, page, pageSize: pageSizeOption });
      }
      const allRows: Row[] = [];
      let currentPage = 1;
      let total = 0;
      while (true) {
        const response = await client.parcels.list({ ...filter, page: currentPage, pageSize: 500 });
        allRows.push(...(response.rows as unknown as Row[]));
        total = response.total;
        if (allRows.length >= total || response.rows.length === 0) break;
        currentPage += 1;
      }
      return { rows: allRows.slice(0, total), total, page: 1, pageSize: Math.max(total, 1) };
    },
    enabled: !dateRangeInvalid,
    placeholderData: (prev) => prev,
  });

  const columns: Column<Row>[] = [
    { key: "awb", header: "Tracking number", width: "w-[150px]", cell: (r) => <MonoCell>{r.awb}</MonoCell> },
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
      key: "destinationBranch",
      header: "Destination hub / district",
      cell: (r) => <span className="text-muted-foreground" title={destinationDisplay(r)}>{destinationDisplay(r)}</span>,
    },
    {
      key: "dest",
      header: "Delivery address",
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
    {
      key: "label",
      header: "Address label",
      align: "right",
      width: "w-[165px]",
      cell: (r) => (
        <MerchantAddressLabel
          awb={r.awb}
          fromName={merchant?.name ?? "Merchant"}
          fromAddress={merchant?.address ?? ""}
          fromPhone={merchant?.contactPhone}
          toName={r.consigneeName}
          toAddress={r.destAddress}
          toPhone={r.consigneePhone}
          buttonLabel="Print label"
          disabled={!merchant?.address}
        />
      ),
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
        error={dateRangeInvalid ? "The start date must be on or before the end date." : list.error ? apiMessage(list.error, "Your parcel list is unavailable.") : null}
        onRowClick={(r) => setOpenAwb(r.awb)}
        emptyTitle="No parcel matches this filter"
        emptyDescription="Search matches tracking number, consignee name and consignee phone. New parcels are booked under Book parcels."
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
                  placeholder="tracking number, consignee or phone"
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
            {search || status || createdFrom || createdTo ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setStatus("");
                  setCreatedFrom("");
                  setCreatedTo("");
                }}
              >
                Reset
              </Button>
            ) : null}
            <div className="ml-auto flex flex-wrap items-end gap-2">
              <Field label="Booked from" className="w-36">
                <Input type="date" max={colomboToday()} value={createdFrom} onChange={(event) => setCreatedFrom(event.target.value)} aria-label="Booked from date" />
              </Field>
              <Field label="Booked to" className="w-36">
                <Input type="date" max={colomboToday()} value={createdTo} onChange={(event) => setCreatedTo(event.target.value)} aria-label="Booked to date" />
              </Field>
              <Field label="Rows" className="w-28">
                <Select value={String(pageSizeOption)} onChange={(event) => setPageSizeOption(event.target.value === "all" ? "all" : Number(event.target.value) as 50 | 100 | 500)}>
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="500">500</option>
                  <option value="all">All</option>
                </Select>
              </Field>
            </div>
            <div className="self-end">
              <ExportCsvButton<Row>
                filename={`shipments-${colomboToday()}.csv`}
                header={["tracking_number", "status", "consignee_name", "consignee_phone", "destination_hub_or_district", "delivery_address", "weight_g", "cod_rs", "booked_at"]}
                toRow={(r) => [r.awb, r.status, r.consigneeName, r.consigneePhone, destinationDisplay(r), r.destAddress, r.weightGrams, centsToRupees(r.codAmountCents), new Date(r.createdAt).toISOString()]}
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
          pageSize: list.data?.pageSize ?? (pageSizeOption === "all" ? 1 : pageSizeOption),
          total: list.data?.total ?? 0,
          onPageChange: setPage,
        }}
        className="min-h-0 flex-1"
      />
      <ParcelDrawer awb={openAwb} onOpenChange={(open) => !open && setOpenAwb(null)} />
    </Page>
  );
}

function destinationDisplay(row: Pick<Row, "destinationBranchName" | "destinationDistrict" | "destinationResolutionStatus">): string {
  if (row.destinationBranchName?.trim()) return row.destinationBranchName.trim();
  if (!row.destinationDistrict) return "District not found";
  if (row.destinationResolutionStatus === "multiple-locations-for-district") {
    return `${row.destinationDistrict} district · multiple locations`;
  }
  if (row.destinationResolutionStatus === "no-location-for-district") {
    return `${row.destinationDistrict} district · no hub listed`;
  }
  return `${row.destinationDistrict} district`;
}
