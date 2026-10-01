import * as React from "react";
import { Truck, PackagePlus, Send, MapPin } from "lucide-react";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { Page, Card, ErrorNote, SuccessNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { dateTime, humanise } from "@/lib/format";
import { useAuth } from "@/components/auth-provider";
import { BagStatusBadge } from "./bagging";
import {
  useBags,
  useBranches,
  useLinehaul,
  useTrip,
  useTripArrive,
  useTripCreate,
  useTripDepart,
  useTripLoad,
} from "@/queries/transport";

/**
 * Linehaul board (§10 M2). Trips between hubs, with their load.
 *
 * The order is enforced by the server and simply reflected here: only a sealed
 * bag can be loaded, a trip with no bags cannot depart, and departure is the
 * moment every parcel aboard moves Bagged → InTransit. Arrival moves the
 * vehicle only — the parcels move when the destination hub receives the bag.
 */

const TRIP_VARIANT: Record<string, "muted" | "brand" | "warn" | "good"> = {
  planned: "muted",
  loading: "brand",
  departed: "warn",
  arrived: "good",
  closed: "good",
  cancelled: "muted",
};

function TripStatusBadge({ status }: { status: string }) {
  return <Badge variant={TRIP_VARIANT[status] ?? "muted"}>{humanise(status)}</Badge>;
}

interface TripRow {
  id: string;
  code: string;
  vehicleRegistration: string;
  driverName: string | null;
  route: string | null;
  status: string;
  seal: string | null;
  originHubName: string;
  destHubName: string;
  bagCount: number;
  parcelCount: number;
  bagsReceived: number;
  departedAt: Date | string | null;
  arrivedAt: Date | string | null;
  createdAt: Date | string;
}

export default function OpsLinehaul() {
  const { session } = useAuth();
  const myBranchId = session?.user.branchId ?? "";

  const [openTripId, setOpenTripId] = React.useState<string | null>(null);
  const [vehicle, setVehicle] = React.useState("");
  const [destHubId, setDestHubId] = React.useState("");
  const [route, setRoute] = React.useState("");
  const [seal, setSeal] = React.useState("");
  const [bagToLoad, setBagToLoad] = React.useState("");
  const [notice, setNotice] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);

  const board = useLinehaul();
  const branches = useBranches();
  const sealedBags = useBags(["sealed"]);
  const trip = useTrip(openTripId);

  const detail = trip.data ?? null;
  const destinations = (branches.data ?? []).filter((b) => b.id !== myBranchId);

  const fail = (message: string) => {
    setNotice(null);
    setProblem(message);
  };
  const ok = (message: string) => {
    setProblem(null);
    setNotice(message);
  };

  const create = useTripCreate({
    onSuccess: (row) => {
      setVehicle("");
      setRoute("");
      setOpenTripId(row.id);
      ok(`Trip ${row.code} created. Load sealed bags onto it.`);
    },
    onError: fail,
  });

  const load = useTripLoad({
    onSuccess: () => {
      setBagToLoad("");
      ok("Bag loaded.");
    },
    onError: fail,
  });

  const depart = useTripDepart({
    onSuccess: () => {
      setSeal("");
      ok("Trip despatched. Every parcel aboard is now In transit.");
    },
    onError: fail,
  });

  const arrive = useTripArrive({
    onSuccess: () =>
      ok("Arrival recorded. The parcels move when the destination hub receives each bag."),
    onError: fail,
  });

  // Only bags whose destination matches the trip's may be offered.
  const loadable = (sealedBags.data ?? []).filter(
    (b) => !b.tripId && (!detail || b.destHubId === detail.trip.destHubId),
  );

  const columns: Column<TripRow>[] = [
    { key: "code", header: "Trip", width: "w-[130px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    {
      key: "vehicle",
      header: "Vehicle",
      width: "w-[110px]",
      cell: (r) => <MonoCell>{r.vehicleRegistration}</MonoCell>,
    },
    {
      key: "leg",
      header: "Leg",
      cell: (r) => (
        <span className="truncate">
          {r.originHubName} <span className="text-muted-foreground">→</span> {r.destHubName}
        </span>
      ),
    },
    {
      key: "load",
      header: "Load",
      width: "w-[120px]",
      align: "right",
      cell: (r) => (
        <MonoCell className="text-muted-foreground">
          {r.bagCount} bag{r.bagCount === 1 ? "" : "s"} / {r.parcelCount}
        </MonoCell>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "w-[110px]",
      cell: (r) => <TripStatusBadge status={r.status} />,
    },
    {
      key: "seal",
      header: "Seal",
      width: "w-[110px]",
      cell: (r) => <MonoCell>{r.seal ?? "—"}</MonoCell>,
    },
    {
      key: "departed",
      header: "Departed",
      width: "w-[150px]",
      cell: (r) => <span className="text-muted-foreground">{dateTime(r.departedAt)}</span>,
    },
  ];

  const trips = (board.data?.trips ?? []) as unknown as TripRow[];

  return (
    <Page
      title="Linehaul"
      description="Trips between hubs. A bag must be sealed before it can be loaded, a trip must carry at least one bag before it can depart, and departure is what moves every parcel aboard into In transit."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricTile
          label="Planned"
          value={board.data?.counts.planned ?? "—"}
          hint="Created or loading, not yet away."
        />
        <MetricTile
          label="In flight"
          value={board.data?.counts.inFlight ?? "—"}
          hint="Departed, not yet arrived."
        />
        <MetricTile
          label="Arrived"
          value={board.data?.counts.arrived ?? "—"}
          hint="At the destination hub, awaiting receipt."
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Trips" description="Click a trip to load, despatch or receive it." bodyClassName="p-0">
          <DataTable
            columns={columns}
            rows={trips}
            rowKey={(r) => r.id}
            loading={board.isLoading}
            error={board.error ? "The linehaul board is unavailable right now." : null}
            emptyTitle="No linehaul trips"
            emptyDescription="Create a trip on the right, then load this hub's sealed bags onto it."
            onRowClick={(r) => {
              setOpenTripId(r.id);
              setProblem(null);
              setNotice(null);
            }}
            className="rounded-none border-0"
          />
        </Card>

        <div className="flex flex-col gap-4">
          {notice ? <SuccessNote>{notice}</SuccessNote> : null}
          {problem ? <ErrorNote>{problem}</ErrorNote> : null}

          <Card title="Create a trip" description="One vehicle, one destination hub.">
            <div className="flex flex-col gap-3">
              <Field label="Vehicle registration">
                <Input
                  value={vehicle}
                  onChange={(e) => setVehicle(e.target.value.toUpperCase())}
                  placeholder="WP-LM-4821"
                  className="font-mono"
                />
              </Field>
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
              <Field label="Route" hint="Optional free text, e.g. via A1.">
                <Input
                  value={route}
                  onChange={(e) => setRoute(e.target.value)}
                  placeholder="Colombo → Kandy via A1"
                />
              </Field>
              <Button
                disabled={vehicle.trim().length < 3 || !destHubId}
                pending={create.isPending}
                onClick={() =>
                  create.mutate({
                    vehicleRegistration: vehicle.trim(),
                    destHubId,
                    route: route.trim() || null,
                  })
                }
              >
                <Truck aria-hidden />
                Create trip
              </Button>
            </div>
          </Card>

          <Card
            title="Sealed and waiting"
            description="Bags sealed at this hub with no trip yet."
            bodyClassName="p-0"
          >
            <ul className="divide-y divide-border">
              {sealedBags.isLoading ? (
                <li className="px-5 py-4 text-[13px] text-muted-foreground">Loading…</li>
              ) : (sealedBags.data ?? []).filter((b) => !b.tripId).length === 0 ? (
                <li className="px-5 py-5 text-[13px] text-muted-foreground">
                  Nothing is sealed and waiting. Seal a bag on the Bagging screen first.
                </li>
              ) : (
                (sealedBags.data ?? [])
                  .filter((b) => !b.tripId)
                  .map((b) => (
                    <li key={b.id} className="flex items-center gap-3 px-5 py-3">
                      <span className="min-w-0 flex-1">
                        <span className="block font-mono text-[13px] font-medium">{b.code}</span>
                        <span className="block truncate text-[12px] text-muted-foreground">
                          → {b.destHubName} · seal {b.sealNumber}
                        </span>
                      </span>
                      <span className="font-mono text-[13px]">{b.itemCount}</span>
                    </li>
                  ))
              )}
            </ul>
          </Card>
        </div>
      </div>

      <Drawer
        open={Boolean(openTripId)}
        onOpenChange={(open) => {
          if (!open) setOpenTripId(null);
        }}
        title={detail ? detail.trip.code : "Trip"}
        subtitle={
          detail
            ? `${detail.trip.vehicleRegistration} · ${detail.originHubName} → ${detail.destHubName}`
            : undefined
        }
      >
        {trip.isLoading ? (
          <p className="px-5 py-6 text-[13px] text-muted-foreground">Loading the trip…</p>
        ) : !detail ? (
          <p className="px-5 py-6 text-[13px] text-muted-foreground">
            This trip could not be loaded.
          </p>
        ) : (
          <div className="natex-scroll flex-1 overflow-auto px-5 py-5">
            <div className="flex flex-col gap-5">
              <KeyValueGrid>
                <KeyValue label="Status">
                  <TripStatusBadge status={detail.trip.status} />
                </KeyValue>
                <KeyValue label="Vehicle seal" mono>
                  {detail.trip.seal ?? "Not sealed"}
                </KeyValue>
                <KeyValue label="Driver">{detail.trip.driverName ?? "Unassigned"}</KeyValue>
                <KeyValue label="Route">{detail.trip.route ?? "—"}</KeyValue>
                <KeyValue label="Departed">{dateTime(detail.trip.departedAt)}</KeyValue>
                <KeyValue label="Arrived">{dateTime(detail.trip.arrivedAt)}</KeyValue>
                <KeyValue label="Bags" mono>
                  {detail.bags.length}
                </KeyValue>
                <KeyValue label="Parcels aboard" mono>
                  {detail.parcelCount}
                </KeyValue>
              </KeyValueGrid>

              <div>
                <p className="label-xs mb-2 text-muted-foreground">Load</p>
                {detail.bags.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    Nothing loaded. A trip cannot depart empty.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {detail.bags.map((b) => (
                      <li
                        key={b.id}
                        className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block font-mono text-[13px] font-medium">{b.code}</span>
                          <span className="block truncate text-[12px] text-muted-foreground">
                            → {b.destHubName} · seal {b.sealNumber ?? "none"}
                          </span>
                        </span>
                        <span className="font-mono text-[13px]">{b.itemCount}</span>
                        <BagStatusBadge status={b.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {detail.trip.status === "planned" || detail.trip.status === "loading" ? (
                <>
                  <div className="flex flex-col gap-3 rounded-md border border-border p-4">
                    <p className="text-[13px] font-semibold">Load a sealed bag</p>
                    <Select value={bagToLoad} onChange={(e) => setBagToLoad(e.target.value)}>
                      <option value="">Choose a sealed bag…</option>
                      {loadable.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.code} — {b.itemCount} parcels → {b.destHubName}
                        </option>
                      ))}
                    </Select>
                    {loadable.length === 0 ? (
                      <p className="text-[12px] text-muted-foreground">
                        No sealed bag for {detail.destHubName} is waiting. Seal one on the Bagging
                        screen.
                      </p>
                    ) : null}
                    <Button
                      variant="outline"
                      disabled={!bagToLoad}
                      pending={load.isPending}
                      onClick={() =>
                        load.mutate({ tripId: detail.trip.id, bagId: bagToLoad })
                      }
                    >
                      <PackagePlus aria-hidden />
                      Load bag
                    </Button>
                  </div>

                  <div className="flex flex-col gap-3 rounded-md border border-border p-4">
                    <p className="text-[13px] font-semibold">Despatch</p>
                    <p className="text-[12px] text-muted-foreground">
                      Moves every parcel aboard to In transit. Refused while any loaded bag is
                      unsealed, or while the trip is empty.
                    </p>
                    <Field label="Vehicle seal">
                      <Input
                        value={seal}
                        onChange={(e) => setSeal(e.target.value.toUpperCase())}
                        placeholder="VS-771204"
                        className="font-mono"
                      />
                    </Field>
                    <Button
                      disabled={seal.trim().length < 3 || detail.bags.length === 0}
                      pending={depart.isPending}
                      onClick={() => depart.mutate({ tripId: detail.trip.id, seal: seal.trim() })}
                    >
                      <Send aria-hidden />
                      Depart
                    </Button>
                  </div>
                </>
              ) : null}

              {detail.trip.status === "departed" ? (
                <div className="flex flex-col gap-3 rounded-md border border-border p-4">
                  <p className="text-[13px] font-semibold">Record arrival</p>
                  <p className="text-[12px] text-muted-foreground">
                    Arrival moves the vehicle, not the parcels. Each bag still has to be received
                    at the destination hub on the Inbound bags screen.
                  </p>
                  <Button
                    variant="outline"
                    pending={arrive.isPending}
                    onClick={() => arrive.mutate({ tripId: detail.trip.id })}
                  >
                    <MapPin aria-hidden />
                    Mark arrived
                  </Button>
                </div>
              ) : null}

              {problem ? <ErrorNote>{problem}</ErrorNote> : null}
              {notice ? <SuccessNote>{notice}</SuccessNote> : null}
            </div>
          </div>
        )}
      </Drawer>
    </Page>
  );
}
