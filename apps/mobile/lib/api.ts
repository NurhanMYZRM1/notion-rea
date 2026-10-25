import { expoClient } from "@better-auth/expo/client";
import { ApiRequestError, createApiClient } from "@workspace/core";
import { createAuthClient } from "better-auth/react";
import { getRandomValues } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

// Hermes has no WebCrypto; @workspace/core ids (newId) need getRandomValues.
const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (!g.crypto?.getRandomValues) g.crypto = { ...(g.crypto ?? {}), getRandomValues };

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const WS_URL = API_URL.replace(/^http/, "ws");
export const SCHEME = "workspace";
export const COOKIE_KEYS = ["workspace_cookie", "workspace_session_data"];

export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [expoClient({ scheme: SCHEME, storagePrefix: "workspace", storage: SecureStore })],
});

export async function authHeaders(): Promise<Record<string, string>> {
  const cookie = await authClient.getCookie();
  return cookie ? { Cookie: cookie } : {};
}

// ---- reachability: expo-network says "connected" even when the API is down, so API failures count too.
let online = true;
const listeners = new Set<() => void>();
export function setOnline(next: boolean) {
  if (next === online) return;
  online = next;
  listeners.forEach((l) => l());
}
export const isOnline = () => online;
export function useOnline(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => online,
  );
}

export const isNetworkError = (err: unknown) => err instanceof ApiRequestError && err.code === "network";

export const api = createApiClient({
  baseUrl: API_URL,
  headers: authHeaders,
  // The Cookie header is the only credential; never let the OS cookie jar add or keep one.
  fetch: async (input, init) => {
    try {
      const res = await fetch(input, { ...init, credentials: "omit" });
      setOnline(true);
      return res;
    } catch (err) {
      setOnline(false);
      throw err;
    }
  },
});

/** RN's WebSocket accepts headers (Cookie) as a third argument; the DOM typing does not. */
type RNWebSocketCtor = new (url: string, protocols: string | string[] | undefined, options: { headers: Record<string, string> }) => WebSocket;
export async function openSocket(path: string): Promise<WebSocket> {
  return new (WebSocket as unknown as RNWebSocketCtor)(`${WS_URL}${path}`, undefined, { headers: await authHeaders() });
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.code === "network" ? "You're offline. Try again when you're connected." : err.message;
  return err instanceof Error ? err.message : "Something went wrong";
}
