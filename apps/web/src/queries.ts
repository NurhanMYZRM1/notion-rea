import { can, type Capability, type Me, type PageDetail, type Role } from "@workspace/core";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Query keys mirror the workspace event channel's invalidation keys, so `invalidateQueries({queryKey})`
 * prefix-matches: ["pages", parentId] → ["pages", parentId, ws]; ["database", id] → rows of that database.
 */
export const qk = {
  me: ["workspaces"] as const,
  grants: ["workspaces", "agent-grants"] as const,
  children: (ws: string, parentId: string | null) => ["pages", parentId, ws] as const,
  page: (id: string) => ["page", id] as const,
  record: (id: string) => ["page", id, "record"] as const,
  database: (id: string) => ["database", id] as const,
  rows: (id: string, ...rest: unknown[]) => ["database", id, "rows", ...rest] as const,
  comments: (pageId: string) => ["comments", pageId] as const,
  members: (ws: string) => ["members", ws] as const,
  invitations: (ws: string) => ["members", ws, "invitations"] as const,
  trash: (ws: string) => ["trash", ws] as const,
  recents: (ws: string) => ["recents", ws] as const,
  favorites: (ws: string) => ["favorites", ws] as const,
};

export const useMe = () => useQuery({ queryKey: qk.me, queryFn: api.me, staleTime: 60_000 });

export function roleIn(me: Me | undefined, ws: string | null | undefined): Role | null {
  return me?.workspaces.find((w) => w.id === ws)?.role ?? null;
}
export const canIn = (me: Me | undefined, ws: string | null | undefined, c: Capability) => can(roleIn(me, ws), c);

export const usePage = (id: string) => useQuery({ queryKey: qk.page(id), queryFn: () => api.page(id).then((r) => r.page) });

/** Refresh everything a page change can affect (also arrives via the event channel; this is for immediacy). */
export function invalidatePage(qc: QueryClient, page: Pick<PageDetail, "id" | "parentId" | "workspaceId" | "databaseId">, extraParents: (string | null)[] = []) {
  void qc.invalidateQueries({ queryKey: qk.page(page.id) });
  for (const p of [page.parentId, ...extraParents]) void qc.invalidateQueries({ queryKey: qk.children(page.workspaceId, p) });
  void qc.invalidateQueries({ queryKey: qk.favorites(page.workspaceId) });
  void qc.invalidateQueries({ queryKey: qk.recents(page.workspaceId) });
  void qc.invalidateQueries({ queryKey: qk.trash(page.workspaceId) });
  if (page.databaseId) void qc.invalidateQueries({ queryKey: qk.database(page.databaseId) });
}

const LAST_WS = "ws-last-workspace";
export function lastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WS);
  } catch {
    return null;
  }
}
export function rememberWorkspace(ws: string) {
  try {
    localStorage.setItem(LAST_WS, ws);
  } catch {
    /* ignore */
  }
}
