import { newId, type PageSummary } from "@workspace/core";
import type { QueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { api } from "./api";

/** All children of a parent. shortcut: follows cursors up to 1000 rows; upgrade to infinite scroll for huge folders. */
export async function allChildren(ws: string, parentId: string | null): Promise<PageSummary[]> {
  const pages: PageSummary[] = [];
  let cursor: string | null = null;
  do {
    const res: { pages: PageSummary[]; nextCursor: string | null } = await api.children(ws, parentId, cursor);
    pages.push(...res.pages);
    cursor = res.nextCursor;
  } while (cursor && pages.length < 1000);
  return pages;
}

/** Same shapes as the web app and the workspace event channel, so invalidations prefix-match. */
export const keys = {
  children: (ws: string, parentId: string | null) => ["pages", parentId, ws] as const,
  favorites: (ws: string) => ["favorites", ws] as const,
  recents: (ws: string) => ["recents", ws] as const,
  trash: (ws: string) => ["trash", ws] as const,
  members: (ws: string) => ["members", ws] as const,
  invitations: (ws: string) => ["members", ws, "invitations"] as const,
  page: (id: string) => ["page", id] as const,
  record: (id: string) => ["page", id, "record"] as const,
  database: (id: string) => ["database", id] as const,
  rows: (id: string, ...rest: unknown[]) => ["database", id, "rows", ...rest] as const,
  comments: (id: string) => ["comments", id] as const,
  grants: ["workspaces", "agent-grants"] as const,
};

/** Keys of the SQLite metadata cache (account-scoped DB, so no user id needed). */
export const kv = {
  children: (ws: string, parentId: string | null) => `children:${ws}:${parentId ?? "root"}`,
  favorites: (ws: string) => `favorites:${ws}`,
  recents: (ws: string) => `recents:${ws}`,
  page: (id: string) => `page:${id}`,
  record: (id: string) => `record:${id}`,
  database: (id: string) => `database:${id}`,
};

export function openPage(p: Pick<PageSummary, "id" | "title" | "isDatabase"> & { workspaceId?: string }, isNew = false) {
  const params = { id: p.id, title: p.title, ws: p.workspaceId ?? "", ...(isNew ? { new: "1" } : {}) };
  if (p.isDatabase) router.push({ pathname: "/database/[id]", params });
  else router.push({ pathname: "/page/[id]", params });
}

export async function createPage(ws: string, parentId: string | null) {
  const { page } = await api.createPage(ws, { id: newId("pg"), parentId, title: "" });
  return page;
}

/** Refresh everything a page lifecycle change can affect (events also arrive; this is for immediacy). */
export function invalidatePage(qc: QueryClient, page: Pick<PageSummary, "id" | "parentId" | "workspaceId" | "databaseId">) {
  void qc.invalidateQueries({ queryKey: keys.page(page.id) });
  void qc.invalidateQueries({ queryKey: keys.children(page.workspaceId, page.parentId) });
  void qc.invalidateQueries({ queryKey: keys.favorites(page.workspaceId) });
  void qc.invalidateQueries({ queryKey: keys.recents(page.workspaceId) });
  void qc.invalidateQueries({ queryKey: keys.trash(page.workspaceId) });
  if (page.databaseId) void qc.invalidateQueries({ queryKey: keys.database(page.databaseId) });
}
