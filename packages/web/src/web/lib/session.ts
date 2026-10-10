/**
 * Session store — the browser half of PROJECT.md §2 (phone + OTP, short-lived
 * access token, rotating refresh token).
 *
 * Deliberately framework-free so `lib/api.ts` can read the access token from a
 * fetch interceptor without going through React. `components/auth-provider.tsx`
 * subscribes to it for the UI.
 */

export type Role = "rider" | "transport" | "ops" | "finance" | "admin" | "merchant" | "hr";

export interface SessionUser {
  id: string;
  name: string;
  role: Role;
  /** Every role the user holds (role === roles[0]); absent on sessions stored before multi-role. */
  roles?: Role[];
  username?: string | null;
  branchId: string;
  branchName: string;
  merchantId: string | null;
  deviceId?: string | null;
}

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which the access token stops being usable. */
  expiresAt: number;
  user: SessionUser;
}

const SESSION_KEY = "natex.session";
const DEVICE_KEY = "natex.deviceId";

let current: StoredSession | null = read();
const listeners = new Set<() => void>();

function read(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.accessToken || !parsed?.user) return null;
    return parsed;
  } catch {
    return null;
  }
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Snapshot for `useSyncExternalStore` — identity is stable between writes. */
export function getSession(): StoredSession | null {
  return current;
}

export function setSession(next: StoredSession | null): void {
  current = next;
  if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  else localStorage.removeItem(SESSION_KEY);
  emit();
}

export function accessToken(): string | null {
  return current?.accessToken ?? null;
}

export function refreshTokenValue(): string | null {
  return current?.refreshToken ?? null;
}

/**
 * Stable per-browser device id. The API binds a rider to one active device
 * (§5); the portals send it too so an audit row always names a device.
 */
export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/** Shape returned by identity.verifyOtp / identity.refresh. */
export interface ApiSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: SessionUser;
  /**
   * MFA level of this session (§2). `enrol`/`challenge` mean the phone OTP
   * passed but the authenticator step has not: such a session is PENDING and
   * must never be stored — the login page finishes it via `mfa.*` first.
   */
  mfa?: { state: "none" | "enrol" | "challenge" | "verified"; devCode?: string };
}

export function isPendingMfa(session: ApiSession): boolean {
  return session.mfa?.state === "enrol" || session.mfa?.state === "challenge";
}

export function storeApiSession(session: ApiSession): StoredSession {
  if (isPendingMfa(session)) throw new Error("Refusing to store a session that has not passed the authenticator step.");
  const stored: StoredSession = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: Date.now() + session.expiresIn * 1000,
    user: session.user,
  };
  setSession(stored);
  return stored;
}
