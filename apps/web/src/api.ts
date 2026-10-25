import { ApiRequestError, createApiClient } from "@workspace/core";
import { createAuthClient } from "better-auth/client";

export const api = createApiClient({ baseUrl: "" });
export const authClient = createAuthClient({ baseURL: location.origin, basePath: "/api/auth" });

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}

export const isConflict = (err: unknown): err is ApiRequestError => err instanceof ApiRequestError && err.code === "conflict";
export const isUnauthenticated = (err: unknown) => err instanceof ApiRequestError && err.status === 401;
export const isNetwork = (err: unknown) => err instanceof ApiRequestError && err.code === "network";

/** `details.current` of a 409 response. */
export function conflictCurrent<T>(err: unknown): T | null {
  if (!isConflict(err)) return null;
  const d = err.details as { current?: T } | undefined;
  return d?.current ?? null;
}

/** Only same-origin relative paths are allowed as post-login destinations. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  try {
    const url = new URL(next, location.origin);
    if (url.origin !== location.origin) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}

const COLORS = ["#1d4ed8", "#047857", "#7e22ce", "#be185d", "#c2410c", "#0e7490", "#a16207", "#4d7c0f"];
/** Deterministic, white-text-safe color per user id (carets, avatars). */
export function userColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase();
}

export function download(name: string, text: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fileSafe = (title: string) => (title.trim() || "Untitled").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
