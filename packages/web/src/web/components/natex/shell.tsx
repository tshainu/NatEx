import * as React from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { LogOut, Building2, ShieldCheck, ChevronDown, Bell, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { orpc } from "@/lib/api";
import { navFor, rolesOfUser, ROLE_LABEL } from "@/lib/permissions";
import { useAuth } from "@/components/auth-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const SIDEBAR_COLLAPSED_KEY = "natex.sidebar.collapsed.v1";

function loadCollapsedSidebarGroups(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((title): title is string => typeof title === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Portal shell — design.md: fixed 232px left sidebar (--ink-800) carrying the
 * portal name, role badge and nav; top bar carries the branch scope selector,
 * current user and sign-out; the content area scrolls independently.
 *
 * The sidebar is dark in every portal; the *content* surface is dark only on
 * the ops board, which opts in by wrapping itself in `.dark`.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const { session, signOut } = useAuth();
  const [location] = useLocation();
  const user = session!.user;
  const userRoles = rolesOfUser(user);
  // The account may have several assigned roles, but the sidebar represents
  // the role selected for this session (`user.role`). Do not merge secondary
  // roles here: an HR login must not inherit Operations, Transport, or
  // Administration menus unless the user actually switches to that role.
  const groups = navFor(user.role);
  const [collapsedGroups, setCollapsedGroups] = React.useState<string[]>(loadCollapsedSidebarGroups);
  const mainRef = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    if (mainRef.current) {
      mainRef.current.scrollTop = 0;
      mainRef.current.scrollLeft = 0;
    }
  }, [location]);

  React.useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(collapsedGroups));
    } catch {
      // Navigation still works when browser storage is unavailable.
    }
  }, [collapsedGroups]);

  return (
    <div className="fixed inset-0 flex overflow-hidden overscroll-none bg-background">
      <aside className="flex h-full min-h-0 w-[232px] shrink-0 flex-col border-r border-ink-600 bg-ink-800">
        <div className="border-b border-ink-600 px-5 py-4">
          <Link
            href={groups[0]?.items[0]?.to ?? "/"}
            className="flex items-center gap-2 outline-none"
          >
            <img
              src="/natex-wordmark-white.png"
              alt="NatEx"
              className="h-[33.6px] w-auto max-w-full object-contain"
            />
          </Link>
          <p className="mt-2.5 text-[15px] font-medium leading-tight text-text-hi">{user.name}</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {userRoles.map((r) => (
              <Badge key={r} variant="brand" className="border-brand/40 bg-brand/15 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-brand">
                {ROLE_LABEL[r]}
              </Badge>
            ))}
          </div>
        </div>

        <nav className="natex-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4">
          {groups.map((group) => {
            const groupId = `sidebar-group-${group.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
            const expanded = !collapsedGroups.includes(group.title);

            return (
              <div key={group.title} className="mb-5 last:mb-0">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={groupId}
                  onClick={() => setCollapsedGroups((current) =>
                    current.includes(group.title)
                      ? current.filter((title) => title !== group.title)
                      : [...current, group.title],
                  )}
                  className="flex min-h-8 w-full items-center justify-between gap-2 rounded px-2 pb-2 text-left font-display text-[11.5px] font-extrabold uppercase leading-tight tracking-[0.08em] text-text-hi transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                >
                  <span>{group.title}</span>
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "size-3 shrink-0 transition-transform duration-150",
                      expanded ? "" : "-rotate-90",
                    )}
                  />
                </button>
                <ul id={groupId} hidden={!expanded} className="space-y-0.5">
                  {group.items.map((item) => {
                    // Longest prefix wins, so "/merchant" (Dashboard) is not lit
                    // while "/merchant/book" is the current screen.
                    const matches = (to: string) =>
                      location === to || (to !== "/" && location.startsWith(`${to}/`));
                    const active =
                      matches(item.to) &&
                      !group.items.some((o) => o.to.length > item.to.length && matches(o.to));
                    return (
                      <li key={item.to}>
                        <Link
                          href={item.to}
                          className={cn(
                            "flex items-center justify-between gap-2 rounded-md px-2 py-[7px] text-[13px] transition-colors duration-120",
                            "outline-none focus-visible:ring-[3px] focus-visible:ring-brand/40",
                            active
                              ? "bg-brand/15 font-semibold text-brand"
                              : "font-medium text-text-lo hover:bg-ink-700 hover:text-text-hi",
                          )}
                        >
                          <span className="truncate">{item.label}</span>
                          {item.milestone ? (
                            <span className="shrink-0 rounded border border-ink-600 px-1 font-mono text-[10px] text-text-lo">
                              M{item.milestone}
                            </span>
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="border-t border-ink-600 px-4 py-3">
          <p className="font-mono text-[10px] leading-relaxed text-text-lo/70">
            Milestones 1–5 shipped · pilot build
          </p>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar onSignOut={signOut} />
        <main ref={mainRef} className="natex-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </main>
      </div>
    </div>
  );
}

function TopBar({ onSignOut }: { onSignOut: () => void }) {
  const user = useAuth().session!.user;
  const [notificationsOpen, setNotificationsOpen] = React.useState(false);
  const roles = rolesOfUser(user);
  const canSeeApprovals = roles.some((role) => ["hr", "finance", "super_admin", "nos_admin"].includes(role));
  const pendingLeaves = useQuery({ ...orpc.hr.leaveRequests.queryOptions({ input: { status: "pending", year: new Date().getFullYear() } }), enabled: canSeeApprovals, refetchInterval: 5_000, refetchOnWindowFocus: true });
  const payrollRuns = useQuery({ ...orpc.hr.payrollRuns.queryOptions(), enabled: canSeeApprovals, refetchInterval: 5_000, refetchOnWindowFocus: true });
  const pendingPayroll = (payrollRuns.data ?? []).filter((run) => run.status === "submitted");
  const pendingAttendance = useQuery({ ...orpc.hr.attendanceRows.queryOptions({ input: { from: `${new Date().getFullYear()}-01-01`, to: new Date().toISOString().slice(0, 10), approvalStatus: "pending" } }), enabled: canSeeApprovals, refetchInterval: 5_000, refetchOnWindowFocus: true });
  const pendingCount = (pendingLeaves.data?.length ?? 0) + pendingPayroll.length + (pendingAttendance.data?.length ?? 0);

  // Branch scope. M1 scopes every read to the signed-in user's branch on the
  // server, so this reports the scope rather than pretending to switch it.
  const branches = useQuery({
    ...orpc.identity.listBranches.queryOptions(),
    enabled: user.role === "ops" || user.role === "admin",
    staleTime: 5 * 60 * 1000,
  });

  const branchName =
    branches.data?.find((b) => b.id === user.branchId)?.name ?? user.branchName;

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-ink-600 bg-ink-900 px-6">
      <div className="flex items-center gap-2 text-[13px] text-text-lo">
        <Building2 className="size-4" aria-hidden />
        <span className="label-xs text-text-lo/70">Branch scope</span>
        <span className="font-medium text-text-hi">{branchName || "—"}</span>
      </div>
      <div className="flex items-center gap-3">
        {user.deviceId ? (
          <span
            className="hidden font-mono text-[11px] text-text-lo md:inline"
            title="Device bound to this session"
          >
            {user.deviceId}
          </span>
        ) : null}
        <span className="text-[13px] text-text-hi">{user.name}</span>
        {canSeeApprovals ? <div className="relative"><button type="button" aria-label={`${pendingCount} pending HR approval${pendingCount === 1 ? "" : "s"}`} onClick={() => setNotificationsOpen((open) => !open)} className={cn("relative inline-flex size-9 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", pendingCount ? "text-status-bad hover:bg-status-bad/15" : "text-status-good hover:bg-status-good/15")}><Bell className="size-4" aria-hidden />{pendingCount ? <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-status-bad px-1 text-center text-[10px] font-semibold leading-4 text-white">{pendingCount > 9 ? "9+" : pendingCount}</span> : null}</button>{notificationsOpen ? <div className="absolute right-0 top-11 z-40 w-80 rounded-lg border border-border bg-card p-3 text-foreground shadow-xl"><div className="mb-2 flex items-center justify-between"><strong className="text-[13px]">HR approvals</strong><span className={cn("text-[11px] font-medium", pendingCount ? "text-status-bad" : "text-status-good")}>{pendingCount ? `${pendingCount} new` : "All clear"}</span></div>{pendingLeaves.data?.slice(0, 6).map(({ request, employeeName, leaveTypeName }) => <Link key={request.id} href="/hr/leave" onClick={() => setNotificationsOpen(false)} className="block rounded-md border-b border-border/60 px-2 py-2 text-[12px] hover:bg-muted/50"><span className="font-medium">Leave approval</span><span className="block text-muted-foreground">{employeeName} · {leaveTypeName} · {request.startsOn}</span></Link>)}{(pendingAttendance.data ?? []).slice(0, 4).map(({ attendance, employeeName }) => <Link key={attendance.id} href="/hr/attendance" onClick={() => setNotificationsOpen(false)} className="block rounded-md border-b border-border/60 px-2 py-2 text-[12px] hover:bg-muted/50"><span className="font-medium">Attendance approval</span><span className="block text-muted-foreground">{employeeName} · {attendance.workDate}</span></Link>)}{pendingPayroll.slice(0, 4).map((run) => <Link key={run.id} href="/hr/payroll" onClick={() => setNotificationsOpen(false)} className="block rounded-md border-b border-border/60 px-2 py-2 text-[12px] hover:bg-muted/50"><span className="font-medium">Payroll approval</span><span className="block text-muted-foreground">{run.code} · {run.periodStart} – {run.periodEnd}</span></Link>)}{pendingCount === 0 ? <div className="flex items-center gap-2 px-2 py-4 text-[12px] text-status-good"><CheckCircle2 className="size-4" /> No approvals waiting.</div> : null}<Link href="/hr/approvals" onClick={() => setNotificationsOpen(false)} className="mt-2 block rounded-md bg-muted/40 px-2 py-2 text-center text-[12px] font-medium hover:bg-muted">Open approvals desk</Link></div> : null}</div> : null}
        <Link
          href="/security"
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-text-lo transition-colors hover:bg-ink-700 hover:text-text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ShieldCheck className="size-4" aria-hidden />
          Security
        </Link>
        <Button variant="dark" size="sm" onClick={onSignOut}>
          <LogOut aria-hidden />
          Sign out
        </Button>
      </div>
    </header>
  );
}
