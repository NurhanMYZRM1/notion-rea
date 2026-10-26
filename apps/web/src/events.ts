import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { qk } from "./queries";

type WorkspaceMessage = { type: "hello" } | { type: "invalidate"; invalidate: (string | null)[][] } | { type: "revoked" };

/** One socket per workspace: metadata invalidations only. Exponential backoff; immediate retry on "online"; no polling. */
export function useWorkspaceEvents(workspaceId: string | null) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!workspaceId) return;
    let sock: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let everOpened = false;

    const connect = () => {
      if (stopped || sock || !navigator.onLine) return;
      const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events/${workspaceId}`);
      sock = s;
      s.onopen = () => {
        retry = 0;
        // Events may have been missed while disconnected: refetch everything.
        if (everOpened) void qc.invalidateQueries();
        everOpened = true;
      };
      s.onmessage = (e) => {
        let msg: WorkspaceMessage;
        try {
          msg = JSON.parse(String(e.data)) as WorkspaceMessage;
        } catch {
          return;
        }
        if (msg.type === "invalidate") {
          for (const key of msg.invalidate) void qc.invalidateQueries({ queryKey: key });
          // Ancestor titles and parent paths are embedded in every mounted PageDetail.
          if (msg.invalidate.some((key) => key[0] === "hierarchy")) void qc.invalidateQueries({ queryKey: ["page"] });
        }
        else if (msg.type === "revoked") void qc.invalidateQueries({ queryKey: qk.me });
      };
      s.onclose = (e) => {
        if (sock === s) sock = null;
        if (e.code === 4403 || e.code === 4401) void qc.invalidateQueries({ queryKey: qk.me });
        schedule();
      };
    };
    const schedule = () => {
      if (stopped || !navigator.onLine) return;
      clearTimeout(timer);
      const delay = Math.min(30_000, 1000 * 2 ** retry) * (0.5 + Math.random() / 2);
      retry = Math.min(retry + 1, 5);
      timer = setTimeout(connect, delay);
    };
    const online = () => {
      clearTimeout(timer);
      retry = 0;
      connect();
    };
    const offline = () => sock?.close();
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      sock?.close(1000);
    };
  }, [workspaceId, qc]);
}
