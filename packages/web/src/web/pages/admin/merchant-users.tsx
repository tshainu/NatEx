import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { dateTime, humanise } from "@/lib/format";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, ConfirmDialog } from "@/components/ui/dialog";
import { Page, ErrorNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { EditMerchantPortalLoginDialog, type PortalUserForEdit } from "../ops/merchant-admin";

interface MerchantUserRow extends PortalUserForEdit {
  role: string;
  roles: string[];
  branchId: string;
  branchName: string | null;
  merchantId: string | null;
  createdAt: string | Date;
}

export default function MerchantUsers() {
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState("");
  const [merchantId, setMerchantId] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<PortalUserForEdit | null>(null);
  const [target, setTarget] = React.useState<MerchantUserRow | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => setPage(1), [search, merchantId]);

  const merchants = useQuery({
    ...orpc.merchants.options.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const merchantName = React.useCallback(
    (id: string | null) => merchants.data?.find((m) => m.id === id)?.name ?? id ?? "Unknown merchant",
    [merchants.data],
  );
  const list = useQuery(
    orpc.identity.listMerchantUsers.queryOptions({
      input: {
        page,
        pageSize: 25,
        search: search.trim() || undefined,
        merchantId: merchantId || undefined,
      },
    }),
  );

  const setStatus = useMutation({
    ...orpc.identity.setUserStatus.mutationOptions(),
    onSuccess: () => {
      setTarget(null);
      void queryClient.invalidateQueries();
    },
    onError: (error) => {
      setTarget(null);
      setProblem(apiMessage(error, "The Merchant account status could not be changed."));
    },
  });

  const rows = (list.data?.rows ?? []) as unknown as MerchantUserRow[];
  const columns: Column<MerchantUserRow>[] = [
    { key: "name", header: "Account holder", cell: (row) => <span className="font-medium">{row.name}</span> },
    { key: "merchant", header: "Merchant", cell: (row) => <span className="truncate">{merchantName(row.merchantId)}</span> },
    { key: "username", header: "Username", width: "w-[140px]", className: "font-mono", cell: (row) => row.username ?? "—" },
    { key: "phone", header: "Phone", width: "w-[150px]", cell: (row) => <MonoCell>{row.phone}</MonoCell> },
    { key: "branch", header: "Branch", width: "w-[160px]", cell: (row) => <span className="text-muted-foreground">{row.branchName ?? row.branchId}</span> },
    { key: "status", header: "Status", width: "w-[110px]", cell: (row) => <Badge variant={row.status === "active" ? "good" : "warn"}>{humanise(row.status)}</Badge> },
    { key: "created", header: "Created", width: "w-[160px]", className: "font-mono text-muted-foreground", cell: (row) => dateTime(row.createdAt) },
    {
      key: "actions",
      header: "Actions",
      width: "w-[210px]",
      align: "right",
      cell: (row) => (
        <span className="inline-flex gap-1">
          <Button variant="outline" size="sm" onClick={(event) => { event.stopPropagation(); setEditing(row); }}>
            Edit sign-in
          </Button>
          <Button variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); setTarget(row); }}>
            {row.status === "active" ? "Suspend" : "Reactivate"}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Merchant users"
      description="Create and manage login accounts linked to a merchant. Staff and official-role accounts remain under Administration → Users. Passwords are write-only and cannot be retrieved after creation."
      actions={<Button onClick={() => setCreating(true)}><Plus aria-hidden />Add Merchant user</Button>}
      bleed
    >
      {problem ? <ErrorNote className="shrink-0">{problem}</ErrorNote> : null}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={list.isLoading}
        error={list.error ? apiMessage(list.error, "Merchant users are unavailable.") : null}
        emptyTitle="No Merchant user matches these filters"
        emptyDescription="Create a login for a merchant, or clear the search and merchant filter."
        filters={
          <>
            <Field label="Search" className="w-72">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, username or phone" className="pl-8" />
              </div>
            </Field>
            <Field label="Merchant" className="w-64">
              <Select value={merchantId} onChange={(event) => setMerchantId(event.target.value)}>
                <option value="">All merchants</option>
                {(merchants.data ?? []).map((merchant) => (
                  <option key={merchant.id} value={merchant.id}>{merchant.name}{merchant.status !== "active" ? ` (${merchant.status})` : ""}</option>
                ))}
              </Select>
            </Field>
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

      <CreateMerchantUserDialog open={creating} onOpenChange={setCreating} />
      {editing ? <EditMerchantPortalLoginDialog key={editing.id} user={editing} onClose={() => setEditing(null)} /> : null}
      {target ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          title={target.status === "active" ? "Suspend this Merchant user?" : "Reactivate this Merchant user?"}
          objectName={`${target.name} · ${merchantName(target.merchantId)}`}
          destructive={target.status === "active"}
          confirmLabel={target.status === "active" ? "Suspend" : "Reactivate"}
          pending={setStatus.isPending}
          body={target.status === "active" ? "This user will no longer be able to sign in; active sessions are revoked." : "This Merchant portal login will be enabled again."}
          onConfirm={() => setStatus.mutate({ userId: target.id, status: target.status === "active" ? "suspended" : "active" })}
        />
      ) : null}
    </Page>
  );
}

function CreateMerchantUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [merchantId, setMerchantId] = React.useState("");
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const merchants = useQuery({ ...orpc.merchants.options.queryOptions(), staleTime: 5 * 60 * 1000 });
  const activeMerchants = (merchants.data ?? []).filter((merchant) => merchant.status === "active");

  const create = useMutation({
    ...orpc.identity.createMerchantUser.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      setName(""); setPhone(""); setUsername(""); setPassword("");
      onOpenChange(false);
    },
    onError: (error) => setProblem(apiMessage(error, "The Merchant user could not be created.")),
  });
  const close = (next: boolean) => {
    if (!next) { setPassword(""); setProblem(null); }
    onOpenChange(next);
  };
  const ready = Boolean(merchantId) && name.trim().length >= 2 && phone.trim().length >= 9 && username.trim().length >= 2 && password.length >= 8;

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Create Merchant user"
      description="The new login is linked to exactly one active merchant. The password is stored securely and will not be shown again."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
          <Button disabled={!ready} pending={create.isPending} onClick={() => create.mutate({ merchantId, name: name.trim(), phone: phone.trim(), username: username.trim(), password })}>Create account</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Merchant">
          <Select value={merchantId} onChange={(event) => setMerchantId(event.target.value)}>
            <option value="">Choose a merchant</option>
            {activeMerchants.map((merchant) => <option key={merchant.id} value={merchant.id}>{merchant.name}</option>)}
          </Select>
        </Field>
        <Field label="Account holder name"><Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></Field>
        <Field label="Login phone"><Input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="0771234567" className="font-mono" /></Field>
        <Field label="Username"><Input value={username} onChange={(event) => setUsername(event.target.value)} autoCapitalize="none" autoCorrect="off" autoComplete="username" className="font-mono" /></Field>
        <Field label="Password" hint="At least 8 characters. Share it directly with the merchant."><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} /></Field>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}
