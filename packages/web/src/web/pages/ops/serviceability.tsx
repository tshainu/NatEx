import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Crosshair } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { fromE6, metres, coords } from "@/lib/format";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Page, Card, KeyValue, KeyValueGrid, ErrorNote } from "@/components/natex/page";
import { DataTable, type Column } from "@/components/natex/data-table";

/**
 * Serviceability checker (§5 routing). Answers "do we deliver here, and out of
 * which branch" for a coordinate.
 *
 * KNOWN DEVIATION: PROJECT.md specifies PostGIS ST_Contains over a GiST index.
 * Runable's stack has no PostGIS, so containment is a bounding-box pre-filter
 * plus JS ray-casting on an optional polygon ring, and distance is Haversine
 * rather than the `<->` geography operator. The API returns the `method` it
 * used on every answer, and this page shows it rather than hiding it.
 */

const PRESETS: { label: string; lat: number; lng: number }[] = [
  { label: "Colombo Fort", lat: 6.9344, lng: 79.8428 },
  { label: "Nugegoda", lat: 6.8649, lng: 79.8997 },
  { label: "Negombo", lat: 7.2083, lng: 79.8358 },
  { label: "Kandy", lat: 7.2906, lng: 80.6337 },
  { label: "Jaffna", lat: 9.6615, lng: 80.0255 },
];

interface ZoneRow {
  id: string;
  name: string;
  branchId: string;
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  ring: string | null;
  serviceable: boolean;
}

export default function OpsServiceability() {
  const [lat, setLat] = React.useState("6.9344");
  const [lng, setLng] = React.useState("79.8428");
  const [checked, setChecked] = React.useState<{ lat: number; lng: number } | null>({
    lat: 6.9344,
    lng: 79.8428,
  });
  const [branchFilter, setBranchFilter] = React.useState("");

  const branches = useQuery({
    ...orpc.identity.listBranches.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });

  const zones = useQuery(
    orpc.routing.listZones.queryOptions({
      input: { branchId: branchFilter || undefined },
    }),
  );

  const check = useQuery({
    ...orpc.routing.checkServiceability.queryOptions({
      input: { lat: checked?.lat ?? 0, lng: checked?.lng ?? 0 },
    }),
    enabled: Boolean(checked),
  });

  const nearest = useQuery({
    ...orpc.routing.nearestBranch.queryOptions({
      input: { lat: checked?.lat ?? 0, lng: checked?.lng ?? 0 },
    }),
    enabled: Boolean(checked),
  });

  const branchName = React.useCallback(
    (id: string) => branches.data?.find((b) => b.id === id)?.name ?? id,
    [branches.data],
  );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return;
    setChecked({ lat: parsedLat, lng: parsedLng });
  };

  const columns: Column<ZoneRow>[] = [
    { key: "name", header: "Zone", cell: (r) => r.name },
    {
      key: "branch",
      header: "Branch",
      width: "w-[180px]",
      cell: (r) => <span className="text-muted-foreground">{branchName(r.branchId)}</span>,
    },
    {
      key: "bbox",
      header: "Bounding box (lat/lng)",
      className: "font-mono text-[11px] text-muted-foreground",
      cell: (r) =>
        `${(fromE6(r.minLat) ?? 0).toFixed(4)},${(fromE6(r.minLng) ?? 0).toFixed(4)} → ${(
          fromE6(r.maxLat) ?? 0
        ).toFixed(4)},${(fromE6(r.maxLng) ?? 0).toFixed(4)}`,
    },
    {
      key: "shape",
      header: "Shape",
      width: "w-[110px]",
      cell: (r) => (
        <Badge variant={r.ring ? "brand" : "muted"}>{r.ring ? "Polygon" : "Box"}</Badge>
      ),
    },
    {
      key: "serviceable",
      header: "Serviceable",
      width: "w-[120px]",
      cell: (r) => (
        <Badge variant={r.serviceable ? "good" : "warn"}>
          {r.serviceable ? "Yes" : "No"}
        </Badge>
      ),
    },
  ];

  const answer = check.data;

  return (
    <Page
      title="Serviceability"
      description="Ask whether NatEx delivers to a coordinate and which branch owns it. Every answer reports the method that produced it."
    >
      <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Card title="Check a coordinate">
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Latitude">
                  <Input
                    value={lat}
                    onChange={(e) => setLat(e.target.value)}
                    inputMode="decimal"
                    className="font-mono"
                  />
                </Field>
                <Field label="Longitude">
                  <Input
                    value={lng}
                    onChange={(e) => setLng(e.target.value)}
                    inputMode="decimal"
                    className="font-mono"
                  />
                </Field>
              </div>
              <Field label="Jump to" hint="Seeded pilot locations.">
                <Select
                  value=""
                  onChange={(e) => {
                    const preset = PRESETS.find((p) => p.label === e.target.value);
                    if (!preset) return;
                    setLat(String(preset.lat));
                    setLng(String(preset.lng));
                    setChecked({ lat: preset.lat, lng: preset.lng });
                  }}
                >
                  <option value="">Choose a location…</option>
                  {PRESETS.map((p) => (
                    <option key={p.label} value={p.label}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" pending={check.isFetching && !check.data}>
                <Crosshair aria-hidden />
                Check
              </Button>
            </form>
          </Card>

          {check.error ? (
            <ErrorNote>
              {apiMessage(check.error, "The serviceability check could not be run.")}
            </ErrorNote>
          ) : answer ? (
            <Card
              title={answer.serviceable ? "Serviceable" : "Not serviceable"}
              description={answer.reason}
              className={
                answer.serviceable ? "border-status-good/40" : "border-status-warn/40"
              }
            >
              <KeyValueGrid columns={1}>
                <KeyValue label="Coordinate" mono>
                  {coords(checked ? Math.round(checked.lat * 1e6) : null, checked ? Math.round(checked.lng * 1e6) : null)}
                </KeyValue>
                <KeyValue label="Zone">
                  {answer.zone ? answer.zone.name : "No zone covers this point"}
                </KeyValue>
                <KeyValue label="Owning branch">
                  {answer.zone ? branchName(answer.zone.branchId) : "—"}
                </KeyValue>
                <KeyValue label="Nearest branch">
                  {answer.nearestBranch ? (
                    <>
                      {answer.nearestBranch.name}{" "}
                      <span className="font-mono text-muted-foreground">
                        ({metres(answer.nearestBranch.distanceMetres)})
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </KeyValue>
                <KeyValue label="Resolution method" mono>
                  {answer.method === "ring"
                    ? "ray-cast on polygon ring"
                    : answer.method === "bbox"
                      ? "bounding-box containment"
                      : "no zone matched"}
                </KeyValue>
              </KeyValueGrid>
              <p className="mt-4 border-t border-border pt-3 text-[12px] leading-relaxed text-muted-foreground">
                PROJECT.md §5 specifies PostGIS <span className="font-mono">ST_Contains</span>{" "}
                over a GiST index. This stack has no PostGIS, so containment runs as a
                bounding-box pre-filter plus JS ray-casting, and distance is Haversine
                instead of the <span className="font-mono">&lt;-&gt;</span> geography
                operator. Exact for the rectangular pilot zones; not equivalent for complex
                boundaries.
              </p>
            </Card>
          ) : null}

          {nearest.data ? (
            <Card title="Nearest branch by road-less distance">
              <div className="flex items-start gap-3">
                <MapPin className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                <div className="min-w-0">
                  <p className="text-[14px] font-medium">{nearest.data.name}</p>
                  <p className="font-mono text-[12px] text-muted-foreground">
                    {nearest.data.code} · {nearest.data.type} ·{" "}
                    {nearest.data.distanceKm.toFixed(1)} km
                  </p>
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    {nearest.data.address}
                  </p>
                </div>
              </div>
            </Card>
          ) : null}
        </div>

        <Card
          title="Serviceability zones"
          description="Reference data. Zones are created in the admin portal."
          actions={
            <Select
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              className="h-8 w-48 text-[13px]"
            >
              <option value="">All branches</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          }
          bodyClassName="p-0"
        >
          <DataTable
            columns={columns}
            rows={(zones.data ?? []) as unknown as ZoneRow[]}
            rowKey={(r) => r.id}
            loading={zones.isLoading}
            error={zones.error ? apiMessage(zones.error, "Zones are unavailable.") : null}
            emptyTitle="No zone is configured"
            emptyDescription="Until a zone exists, every coordinate falls back to the nearest branch and is reported as not covered."
            className="rounded-none border-0"
          />
        </Card>
      </div>
    </Page>
  );
}
