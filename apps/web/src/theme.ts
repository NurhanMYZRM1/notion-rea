import { workspacePalette } from "@workspace/core/design-tokens";
export type ThemePref = "system" | "light" | "dark";
const KEY = "ws-theme";

export function storedTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(pref: ThemePref) {
  if (pref === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const p = workspacePalette[dark ? "dark" : "light"];
  const tokens = { bg:p.background, fg:p.foreground, muted:p.muted, line:p.border, hover:p.hover, active:p.active, surface:p.surface, sidebar:p.sidebar, accent:p.accent, "accent-solid":p.accentSolid, danger:p.danger, ok:p.success };
  for (const [key,value] of Object.entries(tokens)) document.documentElement.style.setProperty(`--${key}`, value);
}

export function setTheme(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  applyTheme(pref);
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(storedTheme()));
