import * as React from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { LogOut, Building2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { orpc } from "@/lib/api";
import { navFor, ROLE_LABEL } from "@/lib/permissions";
import { useAuth } from "@/components/auth-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
  const groups = navFor(user.role);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <aside className="flex w-[232px] shrink-0 flex-col border-r border-ink-600 bg-ink-800">
        <div className="border-b border-ink-600 px-5 py-4">
          <Link
            href={groups[0]?.items[0]?.to ?? "/"}
            className="flex items-center gap-2 outline-none"
          >
            <span className="grid size-7 place-items-center rounded-md bg-brand font-display text-[13px] font-bold text-primary-foreground">
              N
            </span>
            <span className="font-display text-[16px] font-bold tracking-tight text-text-hi">
              NatEx
            </span>
          </Link>
          <p className="mt-2.5 text-[12px] text-text-lo">{user.name}</p>
          <Badge variant="brand" className="mt-1.5 border-brand/40 bg-brand/15 text-brand">
            {ROLE_LABEL[user.role]}
          </Badge>
        </div>

        <nav className="natex-scroll flex-1 overflow-y-auto px-3 py-4">
          {groups.map((group) => (
            <div key={group.title} className="mb-5 last:mb-0">
              <p className="px-2 pb-2 font-display text-[11.5px] font-extrabold uppercase leading-tight tracking-[0.08em] text-text-hi">
                {group.title}
              </p>
              <ul className="space-y-0.5">
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
          ))}
        </nav>

        <div className="border-t border-ink-600 px-4 py-3">
          <p className="font-mono text-[10px] leading-relaxed text-text-lo/70">
            Milestones 1–5 shipped · pilot build
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onSignOut={signOut} />
        <main className="natex-scroll min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

function TopBar({ onSignOut }: { onSignOut: () => void }) {
  const user = useAuth().session!.user;

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
