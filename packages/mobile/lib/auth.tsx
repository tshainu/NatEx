import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { client } from "./api";
import { resetOutboxMemory } from "./outbox";
import {
  getSession,
  hydrate,
  isHydrated,
  setSession,
  storeApiSession,
  subscribe,
  type ApiSession,
  type Role,
  type SessionUser,
  type StoredSession,
} from "./session";

/**
 * Auth for the field app. The session itself lives in the framework-free store
 * (`lib/session.ts`) so the RPC link can read the token without React; this is
 * only the React window onto it, plus the launch-time hydration gate.
 *
 * Nothing renders until hydration finishes, because a rider who reopens the app
 * mid-shift must not see the login screen flash before their manifests appear.
 */

interface AuthValue {
  /** True once the persisted session has been read from the keychain. */
  ready: boolean;
  session: StoredSession | null;
  user: SessionUser | null;
  role: Role | null;
  roles: Role[];
  signIn: (session: ApiSession) => Promise<void>;
  switchRole: (role: Role) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [ready, setReady] = React.useState(isHydrated);

  const session = React.useSyncExternalStore(subscribe, getSession, getSession);

  React.useEffect(() => {
    let cancelled = false;
    void hydrate().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = React.useCallback(
    async (next: ApiSession) => {
      await storeApiSession(next);
      // A different user may have been signed in on this device; nothing from
      // their shift should survive into this one.
      queryClient.clear();
    },
    [queryClient],
  );

  const switchRole = React.useCallback(
    async (nextRole: Role) => {
      if (!session) return;
      const assigned = session.user.roles?.length ? session.user.roles : [session.user.role];
      if (!assigned.includes(nextRole)) return;
      if ((session.activeRole ?? session.user.role) === nextRole) return;
      // Avoid showing cached results from the previous workspace after switching.
      queryClient.clear();
      await setSession({ ...session, activeRole: nextRole });
    },
    [queryClient, session],
  );

  const signOut = React.useCallback(async () => {
    // Best-effort server-side revocation (identity.logout revokes every
    // refresh token for the user). If the device is offline the local session
    // still goes, which is what the person holding the phone asked for.
    try {
      await client.identity.logout({});
    } catch {
      /* offline sign-out is still a sign-out */
    }
    await setSession(null);
    // The queue itself stays on disk under that rider's id — an unsynced POD
    // is evidence and must reach the server when they next sign in.
    resetOutboxMemory();
    queryClient.clear();
  }, [queryClient]);

  const value = React.useMemo<AuthValue>(
    () => ({
      ready,
      session,
      user: session?.user ?? null,
      role: session?.activeRole ?? session?.user.role ?? null,
      roles: session?.user.roles?.length
        ? session.user.roles
        : session?.user
          ? [session.user.role]
          : [],
      signIn,
      switchRole,
      signOut,
    }),
    [ready, session, signIn, switchRole, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = React.useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>.");
  return value;
}
