import { DurableObject } from "cloudflare:workers";

export interface WorkspaceEvent {
  /** Query keys clients should refetch, e.g. ["pages"], ["page", id], ["database", id], ["members"]. */
  invalidate: (string | null)[][];
  at: number;
}

/**
 * Authenticated metadata invalidation channel for one workspace. Events carry no content, only which
 * queries to refetch. Clients refetch everything after reconnecting, so missed events are harmless.
 */
export class WorkspaceChannel extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get("X-User-Id");
    if (!userId || request.headers.get("Upgrade") !== "websocket") return new Response("Bad request", { status: 400 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [userId]);
    pair[1].send(JSON.stringify({ type: "hello", at: Date.now() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") ws.send("pong");
  }

  async publish(event: WorkspaceEvent): Promise<void> {
    const text = JSON.stringify({ type: "invalidate", ...event });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        /* closing */
      }
    }
  }

  async revokeUser(userId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(userId)) {
      try {
        ws.send(JSON.stringify({ type: "revoked" }));
        ws.close(4403, "revoked");
      } catch {
        /* closed */
      }
    }
  }
}
