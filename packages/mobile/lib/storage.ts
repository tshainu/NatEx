import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

/**
 * Key/value storage for the session and the device id.
 *
 * On a device these go into the OS keychain via `expo-secure-store`: an access
 * token and a refresh token are bearer credentials for a courier account that
 * can move parcels into custody, so they do not belong in plain
 * AsyncStorage.
 *
 * `expo-secure-store` has no web implementation, and the Runable dashboard
 * previews this app through Expo web — so web falls back to `localStorage`,
 * which is exactly what the web portal already uses (`packages/web/src/web/lib/session.ts`).
 * Flagged, not hidden: the web preview is therefore no more secure than the
 * portal, and is for demonstration rather than field use.
 */

const isWeb = Platform.OS === "web";

export async function getItem(key: string): Promise<string | null> {
  if (isWeb) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    // A keychain read can fail on a locked device — treat it as "no session"
    // rather than crashing the app on launch.
    return null;
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  if (isWeb) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      /* private-mode browsers reject writes; the session just won't persist */
    }
    return;
  }
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    /* same: a failed write means the rider signs in again next launch */
  }
}

export async function removeItem(key: string): Promise<void> {
  if (isWeb) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    /* ignore */
  }
}
