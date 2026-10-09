import * as Haptics from "expo-haptics";

/** One brief impact pulse, used for an AWB the current workflow will not accept. */
export function invalidAwbPulse(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
}
