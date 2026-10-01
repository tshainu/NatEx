import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Search } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { date, humanise, amount, grams } from "@/lib/format";
import { BOARD_ORDER } from "@/lib/status";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { StatusPill } from "@/components/natex/status-pill";
import { ParcelDrawer } from "@/components/natex/parcel-drawer";
import { useAuth } from "@/components/auth-provider";

interface Row {
  id: string;
  awb: string;
  status: string;
  merchantId: string;
  consigneeName: string;
  consigneePhone: string;
  destAddress: string;
  weightGrams: number;
  codAmountCents: number;
  createdAt: string | Date;
}

/** Parcel register. Server-side filtering and pagination; scope is server-side too. */
export default function OpsParcels() {
  const { session } = useAuth();
  const role = session!.user.role;
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [merchantId, setMerchantId] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [openAwb, setOpenAwb] = React.useState<string | null>(null);

  const debounced = useDebounced(search, 250);
  React.useEffect(() => setPage(1), [debounced, status, merchantId]);

  const merchants = useQuery({
    ...orpc.merchants.options.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });

  const list = useQuery(
    orpc.parcels.list.queryOptions({
      input: {
        page,
        pageSize: 25,
        search: debounced.trim() || undefined,
        status: status ? [status] : undefined,
        merchantId: merchantId || undefined,
      },
    }),
  );

  const merchantName = React.useCallback(
    (id: string) => merchants.data?.find((m) => m.id === id)?.name ?? id,
    [merchants.data],
  );

  const columns: Column<Row>[] = [
    { key: "awb", header: "AWB", width: "w-[150px]", cell: (r) => <MonoCell>{r.awb}</MonoCell> },
    {
      key: "status",
      header: "Status",
      width: "w-[150px]",
      cell: (r) => <StatusPill status={r.status} />,
    },
    {
      key: "merchant",
      header: "Merchant",
      width: "w-[180px]",
      cell: (r) => <span className="truncate">{merchantName(r.merchantId)}</span>,
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
      title="Parcels"
      description="Every parcel accountable to your branch. Click a row to inspect its custody timeline and command the next legal transition."
      actions={
        role === "ops" || role === "admin" ? (
          <Button asChild>
            <Link href="/ops/book">Book a parcel</Link>
          </Button>
        ) : null
      }
      bleed
    >
      <DataTable
        columns={columns}
        rows={(list.data?.rows ?? []) as unknown as Row[]}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error ? apiMessage(list.error, "The parcel register is unavailable.") : null}
        onRowClick={(r) => setOpenAwb(r.awb)}
        emptyTitle="No parcel matches these filters"
        emptyDescription="Clear the status or merchant filter, or widen the search — it matches AWB, consignee name and consignee phone only."
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
            <Field label="Merchant" className="w-56">
              <Select value={merchantId} onChange={(e) => setMerchantId(e.target.value)}>
                <option value="">All merchants</option>
                {(merchants.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            {search || status || merchantId ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setStatus("");
                  setMerchantId("");
                }}
              >
                Reset
              </Button>
            ) : null}
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

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
