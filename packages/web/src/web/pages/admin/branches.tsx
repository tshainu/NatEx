import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { date, coords } from "@/lib/format";
import { Input, Field, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Page, ErrorNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { useAuth } from "@/components/auth-provider";

/**
 * Branch network (§5 identity). A branch is the unit of row-level scoping:
 * every parcel, merchant and manifest is accountable to one. Coordinates are
 * geocoded once and stored as microdegrees, never re-sent to a maps provider.
 */

interface BranchRow {
  id: string;
  code: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  type: string;
  createdAt: string | Date;
}

export default function AdminBranches() {
  const { session } = useAuth();
  const isAdmin = session!.user.role === "admin";
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<BranchRow | null>(null);

  const branches = useQuery(orpc.identity.listBranches.queryOptions());
  const zones = useQuery(orpc.routing.listZones.queryOptions({ input: {} }));

  const zoneCount = React.useCallback(
    (branchId: string) => (zones.data ?? []).filter((z) => z.branchId === branchId).length,
    [zones.data],
  );

  const columns: Column<BranchRow>[] = [
    { key: "code", header: "Code", width: "w-[100px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    { key: "name", header: "Branch", cell: (r) => <span className="font-medium">{r.name}</span> },
    {
      key: "type",
      header: "Type",
      width: "w-[100px]",
      cell: (r) => (
        <Badge variant={r.type === "hub" ? "brand" : "outline"}>
          {r.type === "hub" ? "Hub" : "Branch"}
        </Badge>
      ),
    },
    {
      key: "address",
      header: "Address",
      cell: (r) => <span className="truncate text-muted-foreground">{r.address}</span>,
    },
    {
      key: "geo",
      header: "Geocode",
      width: "w-[170px]",
      className: "font-mono text-[11px] text-muted-foreground",
      cell: (r) => coords(r.lat, r.lng),
    },
    {
      key: "zones",
      header: "Zones",
      align: "right",
      width: "w-[90px]",
      className: "font-mono",
      cell: (r) => (
        <span className={zoneCount(r.id) ? "" : "text-status-warn"}>{zoneCount(r.id)}</span>
      ),
    },
    {
      key: "since",
      header: "Opened",
      align: "right",
      width: "w-[110px]",
      className: "font-mono text-muted-foreground",
      cell: (r) => date(r.createdAt),
    },
  ];

  return (
    <Page
      title="Branches"
      description={`The branch network. A branch with no serviceability zone can still receive parcels, but no address will resolve to it automatically.${isAdmin ? " Open a row to edit it; the code is permanent." : ""}`}
      actions={
        isAdmin ? (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            Add branch
          </Button>
        ) : null
      }
      bleed
    >
      <DataTable
        columns={columns}
        rows={(branches.data ?? []) as unknown as BranchRow[]}
        rowKey={(r) => r.id}
        onRowClick={isAdmin ? (r) => setEditing(r) : undefined}
        loading={branches.isLoading}
        error={
          branches.error ? apiMessage(branches.error, "The branch network is unavailable.") : null
        }
        emptyTitle="No branch exists yet"
        emptyDescription="At least one branch is required before a user or merchant can be created — every record is scoped to one."
        className="min-h-0 flex-1"
      />
      {isAdmin ? <CreateBranchDialog open={creating} onOpenChange={setCreating} /> : null}
      {isAdmin && editing ? (
        <EditBranchDialog key={editing.id} branch={editing} onClose={() => setEditing(null)} />
      ) : null}
    </Page>
  );
}

function CreateBranchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState({
    code: "",
    name: "",
    address: "",
    lat: "",
    lng: "",
    type: "branch" as "hub" | "branch",
  });
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) setProblem(null);
  }, [open]);

  const create = useMutation({
    ...orpc.identity.createBranch.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      setForm((f) => ({ ...f, code: "", name: "", address: "", lat: "", lng: "" }));
      onOpenChange(false);
    },
    onError: (error) => setProblem(apiMessage(error, "This branch could not be created.")),
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const lat = Number(form.lat);
  const lng = Number(form.lng);
  const ready =
    form.code.trim().length >= 2 &&
    form.name.trim().length >= 2 &&
    form.address.trim().length >= 4 &&
    Number.isFinite(lat) &&
    form.lat !== "" &&
    Number.isFinite(lng) &&
    form.lng !== "";

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a branch"
      description="The code appears on manifests and bag seals, so keep it short and permanent."
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
                code: form.code.trim().toUpperCase(),
                name: form.name.trim(),
                address: form.address.trim(),
                lat,
                lng,
                type: form.type,
              })
            }
          >
            Create branch
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Code" hint="2–12 characters, e.g. CMB01.">
            <Input
              value={form.code}
              onChange={(e) => set("code", e.target.value.toUpperCase())}
              className="font-mono"
            />
          </Field>
          <Field label="Type">
            <Select
              value={form.type}
              onChange={(e) => set("type", e.target.value as "hub" | "branch")}
            >
              <option value="branch">Branch</option>
              <option value="hub">Hub</option>
            </Select>
          </Field>
        </div>
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Address">
          <Textarea value={form.address} onChange={(e) => set("address", e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Latitude" hint="Decimal degrees.">
            <Input
              value={form.lat}
              onChange={(e) => set("lat", e.target.value)}
              inputMode="decimal"
              placeholder="6.9344"
              className="font-mono"
            />
          </Field>
          <Field label="Longitude">
            <Input
              value={form.lng}
              onChange={(e) => set("lng", e.target.value)}
              inputMode="decimal"
              placeholder="79.8428"
              className="font-mono"
            />
          </Field>
        </div>
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          Coordinates are stored as integer microdegrees so nearest-branch distance never
          drifts on floating point. Geocoding happens once, here — the address is never sent
          to a maps provider again.
        </p>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}

function EditBranchDialog({ branch, onClose }: { branch: BranchRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(branch.name);
  const [address, setAddress] = React.useState(branch.address);
  const [lat, setLat] = React.useState(String(branch.lat));
  const [lng, setLng] = React.useState(String(branch.lng));
  const [type, setType] = React.useState(branch.type as "hub" | "branch");
  const [problem, setProblem] = React.useState<string | null>(null);

  const save = useMutation({
    ...orpc.identity.updateBranch.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onClose();
    },
    onError: (error) => setProblem(apiMessage(error, "This branch could not be saved.")),
  });

  const latN = Number(lat);
  const lngN = Number(lng);
  const patch: { id: string; name?: string; address?: string; lat?: number; lng?: number; type?: "hub" | "branch" } = {
    id: branch.id,
  };
  if (name.trim() !== branch.name) patch.name = name.trim();
  if (address.trim() !== branch.address) patch.address = address.trim();
  if (lat !== "" && Number.isFinite(latN) && latN !== branch.lat) patch.lat = latN;
  if (lng !== "" && Number.isFinite(lngN) && lngN !== branch.lng) patch.lng = lngN;
  if (type !== branch.type) patch.type = type;
  const valid =
    name.trim().length >= 2 &&
    address.trim().length >= 4 &&
    lat !== "" &&
    lng !== "" &&
    Number.isFinite(latN) &&
    Number.isFinite(lngN);
  const changed = Object.keys(patch).length > 1;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Edit ${branch.code}`}
      description="The branch code is printed on manifests and seals already in circulation, so it cannot be changed. Moving the geocode changes nearest-branch routing for new addresses only."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || !changed}
            pending={save.isPending}
            onClick={() => {
              setProblem(null);
              save.mutate(patch);
            }}
          >
            Save branch
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as "hub" | "branch")}>
              <option value="branch">Branch</option>
              <option value="hub">Hub</option>
            </Select>
          </Field>
        </div>
        <Field label="Address">
          <Textarea value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Latitude">
            <Input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" className="font-mono" />
          </Field>
          <Field label="Longitude">
            <Input value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" className="font-mono" />
          </Field>
        </div>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}
