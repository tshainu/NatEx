import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Durable JSON storage for the offline half of the rider app: the outbox and
 * the last-known runsheet.
 *
 * Deliberately NOT `lib/storage.ts`. That one is the OS keychain, which is the
 * right home for bearer tokens and the wrong home for a queue — keychain
 * entries are size-limited (a captured signature alone can exceed 2 KB) and
 * slow to write. Nothing stored here is a credential.
 *
 * Every read tolerates corruption by returning the fallback: a half-written
 * entry must cost the rider a re-download, never a crash on launch.
 */
export async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

export async function removeKey(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    /* nothing to remove */
  }
}
