import * as React from "react";
import { PackagePlus, ScanLine as ScanIcon, Lock, Unlock, X } from "lucide-react";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Page, Card, ErrorNote, SuccessNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { StatusPill } from "@/components/natex/status-pill";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { dateTime, grams, humanise, since } from "@/lib/format";
import { useAuth } from "@/components/auth-provider";
import {
  useBag,
  useBaggable,
  useBagCreate,
  useBagRemove,
  useBagScan,
  useBagSeal,
  useBagBreakSeal,
  useBags,
  useBranches,
  useTransportCounts,
} from "@/queries/transport";

/**
 * Bagging (§10 M2). A hub builds a bag for a destination, scans a burst of
 * labels into it, and seals it.
 *
 * Two rules from §7 drive the whole screen:
 *   - a scan burst returns a verdict *per label* — accepted, duplicate or
 *     rejected with a reason — never an all-or-nothing batch error;
 *   - what may happen next is decided by the server (`canScan`, `canSeal`),
 *     not inferred here, so the UI can never offer an illegal action.
 */

interface Verdict {
  awb: string;
  outcome: string;
  reason?: string;
  status?: string;
}

interface ScanResult {
  accepted: Verdict[];
  duplicates: Verdict[];
  rejected: Verdict[];
  itemCount: number;
}

const BAG_STATUS_VARIANT: Record<string, "muted" | "brand" | "warn" | "good"> = {
  open: "muted",
  sealed: "brand",
  in_transit: "warn",
  received: "good",
  reconciled: "good",
  cancelled: "muted",
};

export function BagStatusBadge({ status }: { status: string }) {
  return <Badge variant={BAG_STATUS_VARIANT[status] ?? "muted"}>{humanise(status)}</Badge>;
}

export default function OpsBagging() {
  const { session } = useAuth();
  const myBranchId = session?.user.branchId ?? "";

  const [activeBagId, setActiveBagId] = React.useState<string | null>(null);
  const [destHubId, setDestHubId] = React.useState("");
  const [scanText, setScanText] = React.useState("");
  const [sealNumber, setSealNumber] = React.useState("");
  const [breakReason, setBreakReason] = React.useState("");
  const [scanResult, setScanResult] = React.useState<ScanResult | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);

  const counts = useTransportCounts();
  const branches = useBranches();
  const baggable = useBaggable();
  const bags = useBags(["open", "sealed"]);
  const bag = useBag(activeBagId);

  const detail = bag.data ?? null;

  const awbs = React.useMemo(
    () =>
      Array.from(
        new Set(
          scanText
            .split(/[\s,;]+/)
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
        ),
      ),
    [scanText],
  );

  const fail = (message: string) => {
    setNotice(null);
    setProblem(message);
  };
  const ok = (message: string) => {
    setProblem(null);
    setNotice(message);
  };

  const createBag = useBagCreate({
    onSuccess: (row) => {
      setActiveBagId(row.id);
      setScanResult(null);
      ok(`Bag ${row.code} is open. Scan parcels into it.`);
    },
    onError: fail,
  });

  const scan = useBagScan({
    onSuccess: (result) => {
      const r = result as ScanResult;
      setScanResult(r);
      setScanText("");
      setProblem(null);
      setNotice(
        `${r.accepted.length} accepted, ${r.duplicates.length} already in the bag, ${r.rejected.length} refused.`,
      );
    },
    onError: fail,
  });

  const remove = useBagRemove({ onError: fail });

  const seal = useBagSeal({
    onSuccess: () => {
      setSealNumber("");
      ok("Bag sealed. It can now be loaded onto a linehaul trip.");
    },
    onError: fail,
  });

  const breakSeal = useBagBreakSeal({
    onSuccess: () => {
      setBreakReason("");
      ok("Seal broken. An exception has been raised for the Ops queue.");
    },
    onError: fail,
  });

  // A bag goes somewhere else — your own hub is never a destination.
  const destinations = (branches.data ?? []).filter((b) => b.id !== myBranchId);

  const baggableColumns: Column<{
    id: string;
    awb: string;
    status: string;
    weightGrams: number | null;
    consigneeName: string;
    destAddress: string;
    updatedAt: Date | string;
  }>[] = [
    { key: "awb", header: "AWB", width: "w-[140px]", cell: (r) => <MonoCell>{r.awb}</MonoCell> },
    {
      key: "status",
      header: "Status",
      width: "w-[120px]",
      cell: (r) => <StatusPill status={r.status} />,
    },
    { key: "consignee", header: "Consignee", cell: (r) => r.consigneeName },
    {
      key: "dest",
      header: "Destination",
      cell: (r) => <span className="truncate text-muted-foreground">{r.destAddress}</span>,
    },
    {
      key: "weight",
      header: "Weight",
      width: "w-[90px]",
      align: "right",
      cell: (r) => <MonoCell>{grams(r.weightGrams)}</MonoCell>,
    },
    {
      key: "waiting",
      header: "Waiting",
      width: "w-[110px]",
      cell: (r) => <span className="text-muted-foreground">{since(r.updatedAt)}</span>,
    },
  ];

  const itemColumns: Column<{
    id: string;
    awb: string;
    scannedAt: Date | string;
    scannedByName: string | null;
    removedAt: Date | string | null;
  }>[] = [
    { key: "awb", header: "AWB", width: "w-[140px]", cell: (r) => <MonoCell>{r.awb}</MonoCell> },
    {
      key: "scannedAt",
      header: "Scanned",
      width: "w-[150px]",
      cell: (r) => <span className="text-muted-foreground">{dateTime(r.scannedAt)}</span>,
    },
    { key: "by", header: "By", cell: (r) => r.scannedByName ?? "—" },
    {
      key: "action",
      header: "",
      width: "w-[90px]",
      align: "right",
      cell: (r) =>
        detail?.canScan && !r.removedAt ? (
          <Button
            variant="ghost"
            size="sm"
            pending={remove.isPending}
            onClick={() => {
              if (!activeBagId) return;
              remove.mutate({ bagId: activeBagId, awb: r.awb });
            }}
          >
            <X aria-hidden />
            Take out
          </Button>
        ) : r.removedAt ? (
          <span className="text-[12px] text-muted-foreground">Taken out</span>
        ) : null,
    },
  ];

  const liveItems = (detail?.items ?? []).filter((i) => !i.removedAt);

  return (
    <Page
      title="Bagging"
      description="Build a bag for one destination hub, scan a burst of labels into it, then seal it. Every label gets its own verdict and every scan — accepted, duplicate or refused — is written to the hub scan log."
      actions={
        detail ? (
          <>
            <Badge variant="outline">Bag</Badge>
            <span className="font-mono text-[14px] font-medium">{detail.bag.code}</span>
            <BagStatusBadge status={detail.bag.status} />
          </>
        ) : null
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Bags open"
          value={counts.data?.bagsOpen ?? "—"}
          hint="Being built at your hub."
        />
        <MetricTile
          label="Sealed, not loaded"
          value={counts.data?.bagsSealed ?? "—"}
          hint="Waiting for a linehaul trip."
        />
        <MetricTile
          label="In transit"
          value={counts.data?.bagsInTransit ?? "—"}
          hint="On the road between hubs."
        />
        <MetricTile
          label="Open exceptions"
          value={counts.data?.openExceptions ?? "—"}
          hint="In the Ops exception queue."
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          {detail ? (
            <Card
              title={`Inside ${detail.bag.code}`}
              description={`${detail.originHubName} → ${detail.destHubName} · ${liveItems.length} parcel${liveItems.length === 1 ? "" : "s"}${detail.bag.sealNumber ? ` · seal ${detail.bag.sealNumber}` : ""}`}
              bodyClassName="p-0"
            >
              <DataTable
                columns={itemColumns}
                rows={detail.items}
                rowKey={(r) => r.id}
                loading={bag.isLoading}
                emptyTitle="Nothing scanned in yet"
                emptyDescription="Scan labels into the bag using the pad on the right, or click a row in the ready-to-bag list below."
                className="rounded-none border-0"
                dense
              />
            </Card>
          ) : null}

          {scanResult ? (
            <Card
              title="Last scan burst"
              description="One verdict per label. Nothing was silently dropped."
            >
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="good">{scanResult.accepted.length} accepted</Badge>
                  <Badge variant="muted">{scanResult.duplicates.length} duplicate</Badge>
                  <Badge variant={scanResult.rejected.length ? "bad" : "muted"}>
                    {scanResult.rejected.length} refused
                  </Badge>
                </div>
                {scanResult.accepted.length ? (
                  <div>
                    <p className="label-xs mb-1.5 text-muted-foreground">
                      Accepted — moved to Bagged
                    </p>
                    <p className="font-mono text-[12px] leading-relaxed text-status-good">
                      {scanResult.accepted.map((v) => v.awb).join(", ")}
                    </p>
                  </div>
                ) : null}
                {scanResult.duplicates.length ? (
                  <div>
                    <p className="label-xs mb-1.5 text-muted-foreground">
                      Already in this bag — counted once
                    </p>
                    <p className="font-mono text-[12px] leading-relaxed text-muted-foreground">
                      {scanResult.duplicates.map((v) => v.awb).join(", ")}
                    </p>
                  </div>
                ) : null}
                {scanResult.rejected.length ? (
                  <div>
                    <p className="label-xs mb-1.5 text-muted-foreground">Refused</p>
                    <ul className="flex flex-col gap-1.5">
                      {scanResult.rejected.map((v) => (
                        <li key={v.awb} className="text-[12px]">
                          <span className="font-mono font-medium">{v.awb}</span>
                          <span className="text-muted-foreground"> — {v.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}

          <Card
            title="Ready to bag"
            description="At your hub, in a baggable state, not already held in a live bag."
            bodyClassName="p-0"
          >
            <DataTable
              columns={baggableColumns}
              rows={baggable.data ?? []}
              rowKey={(r) => r.id}
              loading={baggable.isLoading}
              error={baggable.error ? "The ready-to-bag list is unavailable right now." : null}
              emptyTitle="Nothing is waiting to be bagged"
              emptyDescription="Parcels appear here once they are received at this hub and are not already inside an open, sealed or in-transit bag."
              onRowClick={(r) =>
                setScanText((current) =>
                  current.includes(r.awb) ? current : `${current}${current ? "\n" : ""}${r.awb}`,
                )
              }
              className="rounded-none border-0"
            />
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          {detail?.canScan ? (
            <Card title="Scan into bag" description="Paste or scan a burst — duplicates are safe.">
              <div className="flex flex-col gap-4">
                <Field label="AWBs" hint="One per line. Up to 300 per burst.">
                  <Textarea
                    value={scanText}
                    onChange={(e) => setScanText(e.target.value)}
                    placeholder={"NX0000000001\nNX0000000002"}
                    className="min-h-[180px] font-mono text-[13px]"
                  />
                </Field>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[12px] text-muted-foreground">
                    {awbs.length} label{awbs.length === 1 ? "" : "s"}
                  </span>
                  <Button
                    disabled={awbs.length === 0}
                    pending={scan.isPending}
                    onClick={() => {
                      if (!activeBagId) return;
                      scan.mutate({ bagId: activeBagId, awbs });
                    }}
                  >
                    <ScanIcon aria-hidden />
                    Scan burst
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}

          {detail?.canSeal ? (
            <Card title="Seal the bag" description="§6: a bag cannot move without a seal.">
              <div className="flex flex-col gap-3">
                <Field label="Seal number" hint="The tamper-evident seal written on the bag.">
                  <Input
                    value={sealNumber}
                    onChange={(e) => setSealNumber(e.target.value.toUpperCase())}
                    placeholder="SL-004821"
                    className="font-mono"
                  />
                </Field>
                <Button
                  disabled={sealNumber.trim().length < 3}
                  pending={seal.isPending}
                  onClick={() => {
                    if (!activeBagId) return;
                    seal.mutate({ bagId: activeBagId, sealNumber: sealNumber.trim() });
                  }}
                >
                  <Lock aria-hidden />
                  Seal bag
                </Button>
              </div>
            </Card>
          ) : null}

          {detail && detail.bag.status === "sealed" ? (
            <Card
              title="Break the seal"
              description="Always an exception, never a quiet correction."
            >
              <div className="flex flex-col gap-3">
                <Field label="Reason" hint="At least five characters. Recorded against the bag.">
                  <Textarea
                    value={breakReason}
                    onChange={(e) => setBreakReason(e.target.value)}
                    placeholder="Wrong destination hub — parcel for Galle scanned in by mistake."
                    className="min-h-[72px]"
                  />
                </Field>
                <Button
                  variant="outline"
                  disabled={breakReason.trim().length < 5}
                  pending={breakSeal.isPending}
                  onClick={() => {
                    if (!activeBagId) return;
                    breakSeal.mutate({ bagId: activeBagId, reason: breakReason.trim() });
                  }}
                >
                  <Unlock aria-hidden />
                  Break seal
                </Button>
              </div>
            </Card>
          ) : null}

          {notice ? <SuccessNote>{notice}</SuccessNote> : null}
          {problem ? <ErrorNote>{problem}</ErrorNote> : null}

          <Card title="Open a bag" description="One destination hub per bag.">
            <div className="flex flex-col gap-3">
              <Field label="Destination hub">
                <Select value={destHubId} onChange={(e) => setDestHubId(e.target.value)}>
                  <option value="">Choose a hub…</option>
                  {destinations.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.code})
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="outline"
                disabled={!destHubId}
                pending={createBag.isPending}
                onClick={() => createBag.mutate({ destHubId })}
              >
                <PackagePlus aria-hidden />
                Open bag
              </Button>
            </div>
          </Card>

          <Card
            title="Bags at your hub"
            description="Open and sealed. Click one to work on it."
            bodyClassName="p-0"
          >
            <ul className="divide-y divide-border">
              {bags.isLoading ? (
                <li className="px-5 py-4 text-[13px] text-muted-foreground">Loading…</li>
              ) : (bags.data ?? []).length === 0 ? (
                <li className="px-5 py-5 text-[13px] text-muted-foreground">
                  No bag is being built here. Open one above.
                </li>
              ) : (
                (bags.data ?? []).map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveBagId(b.id);
                        setScanResult(null);
                        setProblem(null);
                        setNotice(null);
                      }}
                      className={`flex w-full items-center gap-3 px-5 py-3 text-left transition-colors duration-120 hover:bg-accent ${
                        b.id === activeBagId ? "bg-brand/8" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-mono text-[13px] font-medium">{b.code}</span>
                        <span className="block truncate text-[12px] text-muted-foreground">
                          → {b.destHubName}
                        </span>
                      </span>
                      <span className="font-mono text-[13px]">{b.itemCount}</span>
                      <BagStatusBadge status={b.status} />
                    </button>
                  </li>
                ))
              )}
            </ul>
          </Card>

          {detail ? (
            <Card title="Bag record">
              <KeyValueGrid>
                <KeyValue label="Bag" mono>
                  {detail.bag.code}
                </KeyValue>
                <KeyValue label="Seal" mono>
                  {detail.bag.sealNumber ?? "Not sealed"}
                </KeyValue>
                <KeyValue label="From">{detail.originHubName}</KeyValue>
                <KeyValue label="To">{detail.destHubName}</KeyValue>
                <KeyValue label="Opened">{dateTime(detail.bag.createdAt)}</KeyValue>
                <KeyValue label="Opened by">{detail.bag.createdByName ?? "—"}</KeyValue>
                <KeyValue label="Sealed">{dateTime(detail.bag.sealedAt)}</KeyValue>
                <KeyValue label="Sealed by">{detail.bag.sealedByName ?? "—"}</KeyValue>
                <KeyValue label="Trip" mono>
                  {detail.trip?.code ?? "Not loaded"}
                </KeyValue>
                <KeyValue label="Parcels" mono>
                  {liveItems.length}
                </KeyValue>
              </KeyValueGrid>
            </Card>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
