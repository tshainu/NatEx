import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { date, fromE6 } from "@/lib/format";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Page, Card, ErrorNote } from "@/components/natex/page";
import { DataTable, type Column } from "@/components/natex/data-table";
import { useAuth } from "@/components/auth-provider";

/**
 * Serviceability zones (§5 routing). A zone owns a bounding box and, optionally,
 * a polygon ring. An address resolves to a branch through the zone that
 * contains it; with no zone it falls back to the nearest branch by distance.
 *
 * KNOWN DEVIATION — PROJECT.md §5 specifies PostGIS `ST_Contains` over a GiST
 * index. Turso/SQLite carries no geospatial extension, so containment is a
 * bounding-box pre-filter plus a ray-cast over the ring in JS
 * (api/shared/geo.ts) and distance is Haversine instead of geography `<->`.
 */

interface ZoneRow {
  id: string;
  name: string;
  branchId: string;
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  ring: unknown;
  serviceable: boolean;
  createdAt: string | Date;
}

function degrees(value: number): string {
  const d = fromE6(value);
  return d === null ? "—" : d.toFixed(4);
}

export default function AdminZones() {
  const { session } = useAuth();
  const isAdmin = session!.user.role === "admin";
  const [branchId, setBranchId] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const branches = useQuery(orpc.identity.listBranches.queryOptions());
  const zones = useQuery(
    orpc.routing.listZones.queryOptions({
      input: branchId ? { branchId } : {},
    }),
  );

  const branchName = React.useCallback(
    (id: string) => branches.data?.find((b) => b.id === id)?.name ?? "—",
    [branches.data],
  );

  const columns: Column<ZoneRow>[] = [
    { key: "name", header: "Zone", cell: (r) => <span className="font-medium">{r.name}</span> },
    {
      key: "branch",
      header: "Branch",
      width: "w-[180px]",
      cell: (r) => <span className="text-muted-foreground">{branchName(r.branchId)}</span>,
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
      key: "box",
      header: "Bounding box (decimal degrees)",
      className: "font-mono text-[11px] text-muted-foreground",
      cell: (r) => (
        <span>
          {degrees(r.minLat)}, {degrees(r.minLng)} → {degrees(r.maxLat)}, {degrees(r.maxLng)}
        </span>
      ),
    },
    {
      key: "serviceable",
      header: "Status",
      width: "w-[130px]",
      cell: (r) => (
        <Badge variant={r.serviceable ? "good" : "warn"}>
          {r.serviceable ? "Serviceable" : "Not served"}
        </Badge>
      ),
    },
    {
      key: "since",
      header: "Added",
      align: "right",
      width: "w-[110px]",
      className: "font-mono text-muted-foreground",
      cell: (r) => date(r.createdAt),
    },
  ];

  return (
    <Page
      title="Serviceability zones"
      description="Where NatEx collects and delivers. A booking outside every serviceable zone is still accepted, but it is flagged so the counter can quote manually."
      actions={
        <div className="flex items-center gap-2">
          <Select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className="w-[200px]"
          >
            <option value="">All branches</option>
            {(branches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          {isAdmin ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              Add zone
            </Button>
          ) : null}
        </div>
      }
    >
      <DataTable
        columns={columns}
        rows={(zones.data ?? []) as unknown as ZoneRow[]}
        rowKey={(r) => r.id}
        loading={zones.isLoading}
        error={zones.error ? apiMessage(zones.error, "The zone list is unavailable.") : null}
        emptyTitle="No zone is defined"
        emptyDescription="Without a zone, every address falls back to the nearest branch by straight-line distance."
      />

      <Card title="How containment is decided" className="max-w-3xl">
        <ol className="flex flex-col gap-2 text-[13px] leading-relaxed text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">1. Bounding box.</span> The point is
            tested against each zone&apos;s min/max latitude and longitude — an integer
            comparison on microdegrees.
          </li>
          <li>
            <span className="font-medium text-foreground">2. Ring.</span> If the zone carries a
            polygon ring, a ray-cast decides containment properly; the reported{" "}
            <code className="font-mono text-[12px]">method</code> is then{" "}
            <code className="font-mono text-[12px]">ring</code> rather than{" "}
            <code className="font-mono text-[12px]">bbox</code>.
          </li>
          <li>
            <span className="font-medium text-foreground">3. Fallback.</span> No zone contains
            the point — the nearest branch by Haversine distance is returned with{" "}
            <code className="font-mono text-[12px]">serviceable: false</code>.
          </li>
        </ol>
        <p className="mt-4 rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-[12px] leading-relaxed text-status-warn">
          KNOWN DEVIATION — PROJECT.md §5 specifies PostGIS <code>ST_Contains</code> on a GiST
          index and geography <code>&lt;-&gt;</code> for distance. This build runs on
          Turso/SQLite, which has no geospatial extension, so containment and distance are
          computed in JavaScript. The answers match for the seeded pilot zones; they will drift
          from PostGIS on self-intersecting polygons and at very long distances.
        </p>
      </Card>

      {isAdmin ? <CreateZoneDialog open={creating} onOpenChange={setCreating} /> : null}
    </Page>
  );
}

function CreateZoneDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const branches = useQuery(orpc.identity.listBranches.queryOptions());
  const [form, setForm] = React.useState({
    name: "",
    branchId: "",
    minLat: "",
    minLng: "",
    maxLat: "",
    maxLng: "",
    serviceable: true,
  });
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) setProblem(null);
  }, [open]);

  const create = useMutation({
    ...orpc.routing.createZone.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      setForm((f) => ({ ...f, name: "", minLat: "", minLng: "", maxLat: "", maxLng: "" }));
      onOpenChange(false);
    },
    onError: (error) => setProblem(apiMessage(error, "This zone could not be created.")),
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const nums = {
    minLat: Number(form.minLat),
    minLng: Number(form.minLng),
    maxLat: Number(form.maxLat),
    maxLng: Number(form.maxLng),
  };
  const filled = (["minLat", "minLng", "maxLat", "maxLng"] as const).every(
    (k) => form[k] !== "" && Number.isFinite(nums[k]),
  );
  const ordered = filled && nums.maxLat > nums.minLat && nums.maxLng > nums.minLng;
  const ready = form.name.trim().length >= 2 && form.branchId !== "" && ordered;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a serviceability zone"
      description="A bounding box is enough to start. Polygon rings are imported directly into the database — the counter never draws one by hand."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!ready}
            pending={create.isPending}
            onClick={() =>
              create.mutate({
                name: form.name.trim(),
                branchId: form.branchId,
                minLat: nums.minLat,
                minLng: nums.minLng,
                maxLat: nums.maxLat,
                maxLng: nums.maxLng,
                serviceable: form.serviceable,
              })
            }
          >
            Create zone
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Zone name">
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Colombo 01–05"
          />
        </Field>
        <Field label="Owning branch" hint="Addresses inside this zone route to this branch.">
          <Select value={form.branchId} onChange={(e) => set("branchId", e.target.value)}>
            <option value="">Select a branch</option>
            {(branches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="South-west latitude">
            <Input
              value={form.minLat}
              onChange={(e) => set("minLat", e.target.value)}
              inputMode="decimal"
              placeholder="6.9100"
              className="font-mono"
            />
          </Field>
          <Field label="South-west longitude">
            <Input
              value={form.minLng}
              onChange={(e) => set("minLng", e.target.value)}
              inputMode="decimal"
              placeholder="79.8300"
              className="font-mono"
            />
          </Field>
          <Field label="North-east latitude">
            <Input
              value={form.maxLat}
              onChange={(e) => set("maxLat", e.target.value)}
              inputMode="decimal"
              placeholder="6.9500"
              className="font-mono"
            />
          </Field>
          <Field label="North-east longitude">
            <Input
              value={form.maxLng}
              onChange={(e) => set("maxLng", e.target.value)}
              inputMode="decimal"
              placeholder="79.8800"
              className="font-mono"
            />
          </Field>
        </div>
        <Field label="Serviceable">
          <Select
            value={form.serviceable ? "yes" : "no"}
            onChange={(e) => set("serviceable", e.target.value === "yes")}
          >
            <option value="yes">Yes — NatEx collects and delivers here</option>
            <option value="no">No — mapped, but not served</option>
          </Select>
        </Field>
        {filled && !ordered ? (
          <ErrorNote>
            The north-east corner must be above and to the east of the south-west corner.
          </ErrorNote>
        ) : null}
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}
