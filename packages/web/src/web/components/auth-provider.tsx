import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSession, setSession, subscribe, type StoredSession, type Role } from "@/lib/session";

/**
 * Bridges the framework-free session store (lib/session.ts) into React. The
 * store is the source of truth because lib/api.ts reads the access token from a
 * fetch interceptor, outside any React tree.
 */

interface AuthValue {
  session: StoredSession | null;
  role: Role | null;
  signOut: () => void;
}

const AuthContext = React.createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const session = React.useSyncExternalStore(subscribe, getSession, () => null);
  const queryClient = useQueryClient();

  const signOut = React.useCallback(() => {
    setSession(null);
    // Nothing cached under the old identity may leak into the next one.
    queryClient.clear();
  }, [queryClient]);

  const value = React.useMemo<AuthValue>(
    () => ({ session, role: session?.user.role ?? null, signOut }),
    [session, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = React.useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

/** The signed-in user, or throws — for use inside the authenticated shell. */
export function useUser() {
  const { session } = useAuth();
  if (!session) throw new Error("useUser called outside an authenticated route");
  return session.user;
}
