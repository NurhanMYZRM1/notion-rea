import { workspacePalette } from "@workspace/core/design-tokens";
import { useSyncExternalStore } from "react";
import {
  Appearance,
  DynamicColorIOS,
  Platform,
  useColorScheme,
  type ColorValue,
} from "react-native";

export type ThemePreference = "system" | "light" | "dark";
let preference: ThemePreference = "system";
const listeners = new Set<() => void>();
export function setThemePreference(value: ThemePreference) {
  preference = value;
  Appearance.setColorScheme(value === "system" ? "unspecified" : value);
  listeners.forEach((l) => l());
}
export function useThemePreference() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => preference,
  );
}
export function useThemeScheme(): "light" | "dark" {
  useThemePreference();
  return useColorScheme() === "dark" ? "dark" : "light";
}
const aliases = {
  label: "foreground",
  secondaryLabel: "muted",
  tertiaryLabel: "tertiary",
  separator: "border",
  background: "background",
  grouped: "background",
  card: "surface",
  fill: "hover",
  tint: "foreground",
  onTint: "background",
  danger: "danger",
  warning: "warning",
  success: "success",
  warningBg: "hover",
} as const;
export const colors = {} as Record<keyof typeof aliases, ColorValue>;
for (const [alias, token] of Object.entries(aliases))
  Object.defineProperty(colors, alias, {
    enumerable: true,
    get: () =>
      Platform.OS === "ios"
        ? DynamicColorIOS({
            light: workspacePalette.light[token],
            dark: workspacePalette.dark[token],
          })
        : workspacePalette[
            Appearance.getColorScheme() === "dark" ? "dark" : "light"
          ][token],
  });
export const HIT = Platform.OS === "android" ? 48 : 44;
