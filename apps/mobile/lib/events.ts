import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { CLOSE } from "@workspace/core/sync";
import { addNetworkStateListener } from "expo-network";
import { useEffect } from "react";
import { AppState } from "react-native";
import { openSocket, setOnline } from "./api";

/** Server keys are the web app's query keys; ours are the same keys with a workspace suffix (prefix match). */
export function applyInvalidation(queryClient: QueryClient, keys: (string | null)[][]) {
  for (const key of keys) {
    if (key[0] === "workspaces") void queryClient.invalidateQueries({ queryKey: ["me"] });
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

/** Workspace metadata invalidation channel (`/events/<ws>`); refetches everything after a reconnect. */
export function useWorkspaceEvents(workspaceId: string | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!workspaceId) return;
    let ws: WebSocket | null = null;
    let connecting = false;
    let stopped = false;
    let opened = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;

    const connect = async () => {
      if (stopped || ws || connecting) return;
      connecting = true;
      const sock = await openSocket(`/events/${workspaceId}`).finally(() => (connecting = false));
      if (stopped) return sock.close(1000);
      ws = sock;
      sock.onopen = () => {
        setOnline(true);
        if (opened) void queryClient.invalidateQueries(); // missed events while away
        opened = true;
        retry = 0;
        ping = setInterval(() => sock.readyState === 1 && sock.send("ping"), 25_000);
      };
      sock.onmessage = (e: MessageEvent) => {
        if (typeof e.data !== "string" || e.data === "pong") return;
        try {
          const msg = JSON.parse(e.data) as { type: string; invalidate?: (string | null)[][] };
          if (msg.type === "invalidate" && msg.invalidate) applyInvalidation(queryClient, msg.invalidate);
          if (msg.type === "revoked") void queryClient.invalidateQueries({ queryKey: ["me"] });
        } catch {
          /* ignore malformed */
        }
      };
      sock.onclose = (e: CloseEvent) => {
        clearInterval(ping);
        if (ws === sock) ws = null;
        if (stopped) return;
        // Membership or session changed: refresh the workspace list (the shell reacts to losing access).
        if (e.code === CLOSE.forbidden || e.code === CLOSE.unauthenticated) void queryClient.invalidateQueries({ queryKey: ["me"] });
        timer = setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** retry++) * (0.5 + Math.random() / 2));
      };
    };
    const now = () => {
      if (ws) return;
      clearTimeout(timer);
      retry = 0;
      void connect();
    };
    void connect();
    const app = AppState.addEventListener("change", (s) => s === "active" && now());
    const net = addNetworkStateListener((s) => s.isConnected && s.isInternetReachable !== false && now());
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      app.remove();
      net.remove();
      ws?.close(1000);
    };
  }, [workspaceId, queryClient]);
}
