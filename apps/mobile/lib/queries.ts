import { newId, type PageSummary } from "@workspace/core";
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

export const keys = {
  children: (ws: string, parentId: string | null) => ["pages", parentId, ws] as const,
  favorites: (ws: string) => ["favorites", ws] as const,
  recents: (ws: string) => ["recents", ws] as const,
  trash: (ws: string) => ["trash", ws] as const,
  members: (ws: string) => ["members", ws] as const,
  page: (id: string) => ["page", id] as const,
  record: (id: string) => ["page", id, "record"] as const,
  database: (id: string) => ["database", id] as const,
  comments: (id: string) => ["comments", id] as const,
};

export function openPage(p: Pick<PageSummary, "id" | "title" | "isDatabase">) {
  if (p.isDatabase) router.push({ pathname: "/database/[id]", params: { id: p.id, title: p.title } });
  else router.push({ pathname: "/page/[id]", params: { id: p.id, title: p.title } });
}

export async function createPage(ws: string, parentId: string | null) {
  const { page } = await api.createPage(ws, { id: newId("pg"), parentId, title: "" });
  return page;
}
