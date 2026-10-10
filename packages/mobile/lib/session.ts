import { Platform } from "react-native";
import { randomUUID } from "expo-crypto";
import { getItem, removeItem, setItem } from "./storage";

/**
 * Session store — the field-app half of PROJECT.md §2 (phone + OTP,
 * short-lived access token, rotating refresh token) and §5 ("one active device
 * per rider").
 *
 * Deliberately framework-free, exactly like the web portal's
 * `lib/session.ts`, so `lib/api.ts` can read the access token from a fetch
 * interceptor without going through React. The difference is that device
 * storage is async, so the store is **hydrated once at launch** (`hydrate()`)
 * and every read after that is synchronous against the in-memory copy — the
 * RPC link cannot await a keychain read on each request.
 */

export type Role = "rider" | "transport" | "ops" | "finance" | "admin" | "merchant" | "hr";

export interface SessionUser {
  id: string;
  name: string;
  role: Role;
  /** All roles granted to the account; older sessions may only have `role`. */
  roles?: Role[];
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
  /** Locally selected workspace. The API token still carries the full role set. */
  activeRole?: Role;
}

const SESSION_KEY = "natex.session";
const DEVICE_KEY = "natex.deviceId";

let current: StoredSession | null = null;
let device: string | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/**
 * Load the persisted session and device id into memory. Called once from the
 * auth provider before any screen renders; safe to call again (it is a no-op
 * after the first success).
 */
export async function hydrate(): Promise<StoredSession | null> {
  if (hydrated) return current;

  const [rawSession, rawDevice] = await Promise.all([
    getItem(SESSION_KEY),
    getItem(DEVICE_KEY),
  ]);

  if (rawSession) {
    try {
      const parsed = JSON.parse(rawSession) as StoredSession;
      current = parsed?.accessToken && parsed?.user ? parsed : null;
    } catch {
      current = null;
    }
  }

  // A device id is minted once and then never changes for this install — the
  // API binds a rider to one active device, so a fresh id on every launch would
  // re-bind (and revoke the previous session) on every launch.
  device = rawDevice;
  if (!device) {
    device = `${Platform.OS}-${randomUUID()}`;
    await setItem(DEVICE_KEY, device);
  }

  hydrated = true;
  emit();
  return current;
}

export function isHydrated(): boolean {
  return hydrated;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Snapshot for `useSyncExternalStore` — identity is stable between writes. */
export function getSession(): StoredSession | null {
  return current;
}

export async function setSession(next: StoredSession | null): Promise<void> {
  current = next;
  if (next) await setItem(SESSION_KEY, JSON.stringify(next));
  else await removeItem(SESSION_KEY);
  emit();
}

export function accessToken(): string | null {
  return current?.accessToken ?? null;
}

export function refreshTokenValue(): string | null {
  return current?.refreshToken ?? null;
}

/**
 * Stable per-install device id. The API binds a rider to one active device
 * (§5) and every audit row names a device, so this is sent on every request,
 * signed in or not.
 */
export function deviceId(): string {
  // Before hydration finishes there is nothing to send; the auth provider gates
  // rendering on hydration, so this only guards the launch instant.
  return device ?? "pending";
}

/** Shape returned by identity.verifyOtp / identity.refresh. */
export interface ApiSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: SessionUser;
}

export async function storeApiSession(
  session: ApiSession,
  preferredRole?: Role,
): Promise<StoredSession> {
  const roles = session.user.roles?.length ? session.user.roles : [session.user.role];
  const stored: StoredSession = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: Date.now() + session.expiresIn * 1000,
    user: session.user,
    activeRole: preferredRole && roles.includes(preferredRole) ? preferredRole : session.user.role,
  };
  await setSession(stored);
  return stored;
}

/**
 * Which tab set a role gets. design.md: "Role decides the tab set: a rider
 * never sees transport tabs and vice-versa." Back-office roles have no field
 * workflow at all and are sent to the web portals instead.
 */
export function homeRouteFor(role: Role | undefined): "/login" | "/(rider)" | "/(transport)" | "/(merchant)" | "/desk" {
  if (!role) return "/login";
  if (role === "rider") return "/(rider)";
  if (role === "transport") return "/(transport)";
  if (role === "merchant") return "/(merchant)";
  return "/desk";
}
