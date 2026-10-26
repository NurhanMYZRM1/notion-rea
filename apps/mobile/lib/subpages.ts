import { can, newId, type PageSummary } from "@workspace/core";
import type { ChildPageHost } from "@workspace/editor";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { Alert } from "react-native";
import { choose, showToast } from "@/components/ui";
import { api, errorMessage, isNetworkError } from "./api";
import type { DocSession } from "./doc-session";
import { kvGet, kvSet } from "./doc-store";
import { sqlOf, useAccount } from "./session";
import { submitSubpage } from "./subpage-operation";
import { invalidatePage, keys, kv, openPage } from "./queries";

/** Paged native destination browser. Database branches expose records; only pages/records own subpages. */
export async function movePageTo(qc: QueryClient, pageId: string) {
  const { page } = await api.page(pageId);
  if (page.databaseId)
    throw new Error(
      "Records stay in their database. Their subpages can be moved.",
    );
  let parent: PageSummary | null = null;
  const stack: (PageSummary | null)[] = [];
  let cursor: string | null = null;
  while (true) {
    const result = await api.hierarchy(page.workspaceId, {
      parentId: parent?.id ?? null,
      cursor,
      limit: 100,
    });
    const choices: { label: string; value: string }[] = [];
    if (!parent?.isDatabase && parent?.id !== page.id)
      choices.push({
        label: parent
          ? `Move to ${parent.title || "Untitled"}`
          : "Move to workspace",
        value: "move",
      });
    if (parent) choices.push({ label: "‹ Back", value: "up" });
    for (const node of result.nodes)
      if (node.id !== pageId)
        choices.push({
          label: `${node.isDatabase ? "Database · " : node.databaseId ? "Record · " : ""}${node.title || "Untitled"} ›`,
          value: node.id,
        });
    if (result.nextCursor)
      choices.push({ label: "More pages…", value: "next" });
    const selected = await choose(
      "Move to",
      choices,
      "Open a destination, then choose Move to. Database records stay in their database.",
    );
    if (!selected) return;
    if (selected === "up") {
      parent = stack.pop() ?? null;
      cursor = null;
      continue;
    }
    if (selected === "next") {
      cursor = result.nextCursor;
      continue;
    }
    if (selected === "move") {
      const fresh = (await api.page(pageId)).page;
      await api.movePage(pageId, {
        expectedRevision: fresh.revision,
        parentId: parent?.id ?? null,
      });
      invalidatePage(qc, fresh);
      if (parent)
        void qc.invalidateQueries({
          queryKey: keys.children(page.workspaceId, parent.id),
        });
      showToast("Page moved");
      return;
    }
    const next = result.nodes.find((n) => n.id === selected);
    if (next) {
      stack.push(parent);
      parent = next;
      cursor = null;
    }
  }
}

export function useChildPages(
  page: PageSummary,
  session: DocSession | null,
  role: "owner" | "editor" | "viewer" | null,
): ChildPageHost {
  const qc = useQueryClient();
  const account = useAccount();
  const sql = sqlOf(account);
  const created = useRef(new Set<string>());
  return useMemo(
    () => ({
      resolve: async (ids: string[]) => {
        const results = await Promise.allSettled(
          [...new Set(ids)].map(async (id) => {
            let result: PageSummary;
            try {
              result = await qc.fetchQuery({
                queryKey: keys.page(id),
                queryFn: () => api.page(id).then((r) => r.page),
              });
              void kvSet(sql, kv.page(id), result);
            } catch (err) {
              if (!isNetworkError(err)) throw err;
              const saved = await kvGet<PageSummary>(sql, kv.page(id));
              if (!saved) throw err;
              result = saved;
            }
            // A reference never leaks metadata from a different workspace or a trashed page.
            if (
              result.workspaceId !== page.workspaceId ||
              result.state !== "active" ||
              result.parentId !== page.id
            )
              return null;
            return {
              id: result.id,
              title: result.title || "Untitled",
              icon: result.icon,
            };
          }),
        );
        return results.flatMap((r) =>
          r.status === "fulfilled" && r.value ? [r.value] : [],
        );
      },
      create: async ({ afterBlockId }: { afterBlockId?: string }) => {
        if (!can(role, "write") || page.isDatabase || page.state !== "active")
          throw new Error("You cannot create a subpage here.");
        if (!session)
          throw new Error("Wait for the parent page to finish loading.");
        await session.provider.awaitSynced();
        const { page: child } = await submitSubpage(
          account.dbName,
          page.id,
          afterBlockId,
          {
            read: (key) => kvGet<string | null>(sql, key),
            write: (key, value) => kvSet(sql, key, value),
          },
          () => newId("pg"),
          (id, originalAnchor) =>
            api.createSubpage(page.id, { id, afterBlockId: originalAnchor }),
        );
        invalidatePage(qc, child);
        created.current.add(child.id);
        return {
          id: child.id,
          title: child.title || "Untitled",
          icon: child.icon,
        };
      },
      open: (id: string) => {
        void api
          .page(id)
          .then(({ page: child }) => {
            if (child.workspaceId === page.workspaceId)
              openPage(child, created.current.delete(id));
          })
          .catch((err: unknown) =>
            Alert.alert("Couldn't open page", errorMessage(err)),
          );
      },
      archive: async (id: string) => {
        if (!can(role, "archive"))
          throw new Error("You cannot move this page to Trash.");
        if (!session)
          throw new Error("Wait for the parent page to finish loading.");
        await session.provider.awaitSynced();
        const child = (await api.page(id)).page;
        if (
          child.workspaceId !== page.workspaceId ||
          child.parentId !== page.id
        )
          throw new Error("This page has moved. Refresh before trying again.");
        await api.archivePage(id, { expectedParentId: page.id });
        invalidatePage(qc, child);
        showToast("Page moved to Trash", async () => {
          await api.restorePage(id);
          invalidatePage(qc, child);
        });
      },
      move: (id: string) => {
        void (async () => {
          const child = (await api.page(id)).page;
          if (
            child.workspaceId !== page.workspaceId ||
            child.parentId !== page.id
          )
            throw new Error(
              "This page has moved. Refresh before trying again.",
            );
          await movePageTo(qc, id);
        })().catch((err: unknown) =>
          Alert.alert("Couldn't move page", errorMessage(err)),
        );
      },
      subscribe: (listener: () => void) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const unsub = qc.getQueryCache().subscribe((event) => {
          const key = event.query.queryKey[0];
          if (
            event.type === "updated" &&
            event.action.type === "invalidate" &&
            (key === "page" || key === "hierarchy" || key === "pages")
          ) {
            clearTimeout(timer);
            timer = setTimeout(listener, 100);
          }
        });
        return () => {
          clearTimeout(timer);
          unsub();
        };
      },
    }),
    [
      page.id,
      page.workspaceId,
      page.isDatabase,
      page.state,
      role,
      session,
      qc,
      sql,
      account.dbName,
    ],
  );
}
