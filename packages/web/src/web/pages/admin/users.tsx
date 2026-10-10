import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { humanise } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/permissions";
import type { Role } from "@/lib/session";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, ConfirmDialog } from "@/components/ui/dialog";
import { Page, ErrorNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { useAuth } from "@/components/auth-provider";
import { useMfaFactors } from "@/queries/admin";
import { UserDrawer } from "./user-drawer";
import { OFFICIAL_ROLES, CredentialsFields, RoleCheckboxGroup } from "./user-fields";

/**
 * Staff register (§5 identity). Admin writes; ops reads. A user signs in with
 * phone + OTP, or with a username and password an admin sets here; a rider is
 * additionally bound to one device (§2), shown here rather than invisible.
 */

interface UserRow {
  id: string;
  name: string;
  phone: string;
  role: string;
  roles?: string[];
  username?: string | null;
  status: string;
  deviceId: string | null;
  branchId: string;
  branchName: string | null;
  merchantId: string | null;
  createdAt: string | Date;
}

export default function AdminUsers() {
  const { session } = useAuth();
  const isAdmin = (session!.user.roles ?? [session!.user.role]).includes("admin");

  const [search, setSearch] = React.useState("");
  const [role, setRole] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [target, setTarget] = React.useState<UserRow | null>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const factors = useMfaFactors(isAdmin);
  const factorFor = React.useCallback(
    (userId: string) => factors.data?.find((f) => f.userId === userId),
    [factors.data],
  );

  const users = useQuery(orpc.identity.listUsers.queryOptions());
  const branches = useQuery({
    ...orpc.identity.listBranches.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const sessions = useQuery({
    ...orpc.identity.sessionCounts.queryOptions(),
    enabled: isAdmin,
    refetchInterval: 30_000,
  });

  const queryClient = useQueryClient();
  const [problem, setProblem] = React.useState<string | null>(null);

  const setStatus = useMutation({
    ...orpc.identity.setUserStatus.mutationOptions(),
    onSuccess: () => {
      setTarget(null);
      void queryClient.invalidateQueries();
    },
    onError: (error) => {
      setTarget(null);
      setProblem(apiMessage(error, "That change could not be saved."));
    },
  });

  const activeSessions = React.useCallback(
    (userId: string) =>
      sessions.data?.find((s) => s.userId === userId)?.activeSessions ?? 0,
    [sessions.data],
  );

  const rows = React.useMemo(() => {
    const all = (users.data ?? []) as unknown as UserRow[];
    const term = search.trim().toLowerCase();
    return all.filter((u) => {
      if (role && !(u.roles?.length ? u.roles : [u.role]).includes(role)) return false;
      if (!term) return true;
      return (
        u.name.toLowerCase().includes(term) || u.phone.toLowerCase().includes(term)
      );
    });
  }, [users.data, role, search]);

  const columns: Column<UserRow>[] = [
    { key: "name", header: "Name", cell: (r) => <span className="font-medium">{r.name}</span> },
    {
      key: "phone",
      header: "Phone",
      width: "w-[150px]",
      cell: (r) => <MonoCell>{r.phone}</MonoCell>,
    },
    {
      key: "role",
      header: "Roles",
      width: "w-[190px]",
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {(r.roles?.length ? r.roles : [r.role]).map((x) => (
            <Badge key={x} variant="outline">{ROLE_LABEL[x as Role] ?? x}</Badge>
          ))}
        </span>
      ),
    },
    {
      key: "username",
      header: "Username",
      width: "w-[130px]",
      className: "font-mono text-[12px] text-muted-foreground",
      cell: (r) => r.username ?? "—",
    },
    {
      key: "branch",
      header: "Branch",
      width: "w-[170px]",
      cell: (r) => (
        <span className="text-muted-foreground">{r.branchName ?? r.branchId}</span>
      ),
    },
    {
      key: "device",
      header: "Bound device",
      width: "w-[190px]",
      className: "font-mono text-[11px] text-muted-foreground",
      cell: (r) => r.deviceId ?? "—",
    },
    {
      key: "sessions",
      header: "Sessions",
      align: "right",
      width: "w-[95px]",
      className: "font-mono",
      cell: (r) =>
        isAdmin ? (
          <span className={activeSessions(r.id) ? "text-status-good" : "text-muted-foreground"}>
            {activeSessions(r.id)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "mfa",
      header: "MFA",
      width: "w-[110px]",
      cell: (r) => {
        if (!["ops", "admin", "finance"].some((x) => (r.roles?.length ? r.roles : [r.role]).includes(x)))
          return <span className="text-muted-foreground">n/a</span>;
        if (!isAdmin) return <span className="text-muted-foreground">—</span>;
        const f = factorFor(r.id);
        return f?.enrolled ? (
          <Badge variant={f.seeded ? "muted" : "good"}>{f.seeded ? "Dev seed" : "Enrolled"}</Badge>
        ) : (
          <Badge variant="warn">Not enrolled</Badge>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      width: "w-[110px]",
      cell: (r) => (
        <Badge variant={r.status === "active" ? "good" : "warn"}>{humanise(r.status)}</Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      width: "w-[110px]",
      align: "right",
      cell: (r) =>
        isAdmin && r.id !== session!.user.id ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setTarget(r);
            }}
          >
            {r.status === "active" ? "Suspend" : "Reactivate"}
          </Button>
        ) : null,
    },
  ];

  return (
    <Page
      title="Users"
      description={
        isAdmin
          ? "Official staff and field accounts only; Merchant portal logins are managed on the separate Merchant users screen. A rider is bound to a single device; suspending a user revokes every active session. Open a row to edit the user, see live sessions or reset an authenticator."
          : "Read-only. Only an administrator may create users or change their status; the server refuses the write regardless of what this page shows."
      }
      actions={
        isAdmin ? (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            Add user
          </Button>
        ) : null
      }
      bleed
    >
      {problem ? <ErrorNote className="shrink-0">{problem}</ErrorNote> : null}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={isAdmin ? (r) => setOpenId(r.id) : undefined}
        loading={users.isLoading}
        error={users.error ? apiMessage(users.error, "The user register is unavailable.") : null}
        emptyTitle="No user matches these filters"
        emptyDescription="The search matches name and phone. Non-admin roles only see users in their own branch."
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
                  placeholder="Name or phone"
                  className="pl-8"
                />
              </div>
            </Field>
            <Field label="Role" className="w-48">
              <Select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">All roles</option>
                {OFFICIAL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <span className="ml-auto self-center font-mono text-[12px] text-muted-foreground">
              {rows.length} of {(users.data ?? []).length}
            </span>
          </>
        }
        className="min-h-0 flex-1"
      />

      {isAdmin ? (
        <CreateUserDialog
          open={creating}
          onOpenChange={setCreating}
          branches={branches.data ?? []}
          defaultBranchId={session!.user.branchId}
        />
      ) : null}

      {isAdmin ? (
        <UserDrawer
          user={rows.find((r) => r.id === openId) ?? ((users.data ?? []) as unknown as UserRow[]).find((r) => r.id === openId) ?? null}
          selfId={session!.user.id}
          mfa={openId ? factorFor(openId) : undefined}
          branches={branches.data ?? []}
          onOpenChange={(open) => !open && setOpenId(null)}
        />
      ) : null}

      {target ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          title={target.status === "active" ? "Suspend this user?" : "Reactivate this user?"}
          objectName={`${target.name} · ${target.phone}`}
          destructive={target.status === "active"}
          confirmLabel={target.status === "active" ? "Suspend" : "Reactivate"}
          pending={setStatus.isPending}
          body={
            target.status === "active"
              ? "Every active session is revoked immediately and the next one-time code will be refused. A bound device stays recorded so the same handset can be re-issued later."
              : "The user may request a one-time code again straight away."
          }
          onConfirm={() =>
            setStatus.mutate({
              userId: target.id,
              status: target.status === "active" ? "suspended" : "active",
            })
          }
        />
      ) : null}
    </Page>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
  branches,
  defaultBranchId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: { id: string; name: string }[];
  defaultBranchId: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [roles, setRoles] = React.useState<Role[]>(["rider"]);
  const [branchId, setBranchId] = React.useState(defaultBranchId);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) setProblem(null);
  }, [open]);

  const create = useMutation({
    ...orpc.identity.createUser.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      setName("");
      setPhone("");
      setUsername("");
      setPassword("");
      onOpenChange(false);
    },
    onError: (error) => setProblem(apiMessage(error, "This user could not be created.")),
  });

  const wantsPassword = username.trim().length > 0 || password.length > 0;
  const ready =
    name.trim().length >= 2 &&
    phone.trim().length >= 9 &&
    roles.length >= 1 &&
    branchId &&
    (!wantsPassword || (username.trim().length >= 2 && password.length >= 6));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a user"
      description="The phone number is one way in — Sri Lankan numbers are normalised to +94 on the server. Add a username and password and the user can also sign in without an SMS code."
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
                name: name.trim(),
                phone: phone.trim(),
                roles,
                branchId,
                username: username.trim() || null,
                password: password || null,
              })
            }
          >
            Create user
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Full name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Phone number">
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="0771234567"
            className="font-mono"
          />
        </Field>
        <RoleCheckboxGroup value={roles} onChange={setRoles} roles={OFFICIAL_ROLES} />
        <div className="grid grid-cols-1 gap-4">
          <Field label="Branch">
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <CredentialsFields
          username={username}
          password={password}
          onUsername={setUsername}
          onPassword={setPassword}
        />
        {roles.includes("rider") ? (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
            A rider's device is bound on their first sign-in from the mobile app, not here.
          </p>
        ) : null}
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}
