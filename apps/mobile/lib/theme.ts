import { Color } from "expo-router";
import { Platform, type ColorValue } from "react-native";

const pick = (ios: ColorValue, android: ColorValue, fallback: string): ColorValue => Platform.select({ ios, android, default: fallback })!;

/** Semantic system colors: adapt to dark mode and Increase Contrast automatically. */
export const colors = {
  label: pick(Color.ios.label, Color.android.dynamic.onSurface, "#000"),
  secondaryLabel: pick(Color.ios.secondaryLabel, Color.android.dynamic.onSurfaceVariant, "#3c3c43"),
  tertiaryLabel: pick(Color.ios.tertiaryLabel, Color.android.dynamic.outline, "#8e8e93"),
  separator: pick(Color.ios.separator, Color.android.dynamic.outlineVariant, "#c6c6c8"),
  background: pick(Color.ios.systemBackground, Color.android.dynamic.surface, "#fff"),
  grouped: pick(Color.ios.systemGroupedBackground, Color.android.dynamic.surfaceContainerLow, "#f2f2f7"),
  card: pick(Color.ios.secondarySystemGroupedBackground, Color.android.dynamic.surfaceContainerHigh, "#fff"),
  fill: pick(Color.ios.secondarySystemFill, Color.android.dynamic.surfaceVariant, "#e5e5ea"),
  tint: pick(Color.ios.systemBlue, Color.android.dynamic.primary, "#007aff"),
  onTint: pick("#ffffff", Color.android.dynamic.onPrimary, "#fff"),
  danger: pick(Color.ios.systemRed, Color.android.dynamic.error, "#ff3b30"),
  warning: pick(Color.ios.systemOrange, Color.android.dynamic.tertiary, "#ff9500"),
  success: pick(Color.ios.systemGreen, Color.android.dynamic.secondary, "#34c759"),
  warningBg: pick(Color.ios.tertiarySystemFill, Color.android.dynamic.tertiaryContainer, "#fff4e5"),
};

/** Minimum touch target (Apple HIG / Material: 44pt / 48dp). */
export const HIT = Platform.OS === "android" ? 48 : 44;
