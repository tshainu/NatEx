import React from "react";
import { useColorScheme } from "react-native";
import { getItem, setItem } from "./storage";
import type { ColorScheme } from "../constants/theme";

/**
 * Appearance preference store — Dark / Day / System.
 *
 * Same framework-free shape as `lib/session.ts`: the preference is persisted
 * to device storage, hydrated once at launch, and read synchronously after
 * that so every screen renders the right palette on the first frame.
 *
 * Default is `dark` — the field app is dark-first (constants/theme.ts), so a
 * fresh install and a failed read both land on the night palette, never on a
 * surprise white screen mid-shift.
 */

export type ThemePreference = "dark" | "day" | "system";

const THEME_KEY = "natex.theme";

let preference: ThemePreference = "dark";
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function parse(raw: string | null): ThemePreference {
  return raw === "day" || raw === "system" || raw === "dark" ? raw : "dark";
}

/** Load the persisted preference. Called once from the root layout. */
export async function hydrateTheme(): Promise<ThemePreference> {
  if (hydrated) return preference;
  preference = parse(await getItem(THEME_KEY));
  hydrated = true;
  emit();
  return preference;
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export async function setThemePreference(next: ThemePreference): Promise<void> {
  preference = next;
  emit();
  await setItem(THEME_KEY, next);
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The scheme to actually render with. `system` defers to the OS; the hook form
 * subscribes to both the preference store and the OS scheme.
 */
export function resolveScheme(pref: ThemePreference, system: ColorScheme): ColorScheme {
  if (pref === "day") return "light";
  if (pref === "dark") return "dark";
  return system;
}

/** React hook: the current preference, re-rendering on change. */
export function useThemePreference(): ThemePreference {
  return React.useSyncExternalStore(subscribeTheme, getThemePreference, getThemePreference);
}

/** React hook: the resolved scheme ("light" | "dark") to render with. */
export function useResolvedScheme(): ColorScheme {
  const pref = useThemePreference();
  const system = useColorScheme() ?? "dark";
  return resolveScheme(pref, system === "light" ? "light" : "dark");
}