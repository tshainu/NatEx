import React from "react";
import { getItem, setItem } from "./storage";

/**
 * Field-app settings store — everything a rider tunes on the device itself.
 *
 * Same framework-free shape as `lib/session.ts` / `lib/theme.ts`: persisted to
 * device storage, hydrated once at launch, read synchronously afterwards so
 * the scanner can consult it mid-callback without a hook.
 */

export interface FieldSettings {
  /** Short haptic pulse when a barcode is read. */
  vibrateOnScan: boolean;
  /** Keep the torch on while the scanner sheet is open (dark stairwells). */
  scannerTorch: boolean;
}

const SETTINGS_KEY = "natex.settings";

const DEFAULTS: FieldSettings = {
  vibrateOnScan: true,
  scannerTorch: false,
};

let current: FieldSettings = { ...DEFAULTS };
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Load persisted settings. Called once from the root layout. */
export async function hydrateSettings(): Promise<FieldSettings> {
  if (hydrated) return current;
  const raw = await getItem(SETTINGS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<FieldSettings>;
      current = { ...DEFAULTS, ...parsed };
    } catch {
      current = { ...DEFAULTS };
    }
  }
  hydrated = true;
  emit();
  return current;
}

/** Synchronous read for non-React call sites (the scanner callback). */
export function getSettings(): FieldSettings {
  return current;
}

export async function updateSettings(patch: Partial<FieldSettings>): Promise<void> {
  current = { ...current, ...patch };
  emit();
  await setItem(SETTINGS_KEY, JSON.stringify(current));
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React hook: current settings, re-rendering on change. */
export function useSettings(): FieldSettings {
  return React.useSyncExternalStore(subscribeSettings, getSettings, getSettings);
}