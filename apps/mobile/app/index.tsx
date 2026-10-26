import { can, newId, type PageSummary } from "@workspace/core";
import { FlashList } from "@shopify/flash-list";
import {
  type UseQueryResult,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { Icon } from "@/components/icon";
import {
  Banner,
  Button,
  choose,
  HeaderButton,
  Loading,
  Message,
  Row,
  SectionTitle,
} from "@/components/ui";
import { api, errorMessage, useOnline } from "@/lib/api";
import { inviteTokenFrom } from "@/lib/links";
import { allChildren, createPage, keys, kv, openPage } from "@/lib/queries";
import {
  OfflineError,
  sqlOf,
  useAccount,
  useCachedOptions,
  useCachedQuery,
  useWorkspace,
} from "@/lib/session";
import { useSignOut } from "@/lib/sign-out";
import { colors, HIT, useThemeScheme } from "@/lib/theme";

type Item =
  | { kind: "header"; key: string; title: string }
  | {
      kind: "nav";
      key: string;
      title: string;
      detail?: string;
      onPress: () => void;
      hint?: string;
    }
  | {
      kind: "page";
      key: string;
      page: PageSummary;
      depth: number;
      expanded?: boolean;
      tree: boolean;
    }
  | { kind: "status"; key: string; text: string; depth: number };

export default function Home() {
  useThemeScheme();
  const { me, workspaces, current, select } = useWorkspace();
  if (me.isPending) return <Loading label="Loading workspace" />;
  if (!current) {
    if (me.isError)
      return (
        <Message
          title={
            me.error instanceof OfflineError
              ? "Not available offline"
              : "Couldn't load your workspaces"
          }
          body={errorMessage(me.error)}
        >
          <Button
            kind="plain"
            title="Try again"
            onPress={() => void me.refetch()}
          />
        </Message>
      );
    return <NoWorkspace email={me.data?.user.email ?? ""} />;
  }
  return (
    <WorkspaceHome
      ws={current.id}
      name={current.name}
      canWrite={can(current.role, "write")}
      switcher={
        workspaces.length > 1
          ? () => void switchWorkspace(workspaces, select)
          : undefined
      }
    />
  );
}

async function switchWorkspace(
  workspaces: { id: string; name: string }[],
  select: (id: string) => void,
) {
  const id = await choose(
    "Switch workspace",
    workspaces.map((w) => ({ label: w.name, value: w.id })),
  );
  if (id) select(id);
}

function WorkspaceHome({
  ws,
  name,
  canWrite,
  switcher,
}: {
  ws: string;
  name: string;
  canWrite: boolean;
  switcher?: () => void;
}) {
  const qc = useQueryClient();
  const online = useOnline();
  const make = useCachedOptions();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const favorites = useCachedQuery(keys.favorites(ws), kv.favorites(ws), () =>
    api.favorites(ws).then((r) => r.pages),
  );
  const recents = useCachedQuery(keys.recents(ws), kv.recents(ws), () =>
    api.recents(ws).then((r) => r.pages),
  );
  const parents = useMemo(() => [null, ...expanded], [expanded]);
  const tree = useQueries({
    queries: parents.map((id) =>
      make(keys.children(ws, id), kv.children(ws, id), () =>
        allChildren(ws, id),
      ),
    ),
  });

  const toggle = useCallback(
    (id: string) =>
      setExpanded((s) => {
        const next = new Set(s);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  const items = useMemo(() => {
    const out: Item[] = [
      {
        kind: "nav",
        key: "nav:search",
        title: "Search",
        onPress: () => router.push("/search"),
        hint: "Search pages in this workspace",
      },
      ...(switcher
        ? [
            {
              kind: "nav" as const,
              key: "nav:switch",
              title: "Workspace",
              detail: name,
              onPress: switcher,
              hint: "Switch to another workspace",
            },
          ]
        : []),
      {
        kind: "nav",
        key: "nav:graph",
        title: "Graph",
        onPress: () => router.push("/graph"),
        hint: "Explore the page hierarchy",
      },
      {
        kind: "nav",
        key: "nav:trash",
        title: "Trash",
        onPress: () => router.push("/trash"),
      },
      {
        kind: "nav",
        key: "nav:settings",
        title: "Settings & members",
        onPress: () => router.push("/settings"),
      },
    ];
    if (favorites.data?.length) {
      out.push({ kind: "header", key: "h:fav", title: "Favorites" });
      for (const p of favorites.data)
        out.push({
          kind: "page",
          key: `fav:${p.id}`,
          page: p,
          depth: 0,
          tree: false,
        });
    }
    if (recents.data?.length) {
      out.push({ kind: "header", key: "h:rec", title: "Recent" });
      for (const p of recents.data.slice(0, 5))
        out.push({
          kind: "page",
          key: `rec:${p.id}`,
          page: p,
          depth: 0,
          tree: false,
        });
    }
    out.push({ kind: "header", key: "h:pages", title: "Pages" });
    const byParent = new Map(parents.map((id, i) => [id, tree[i]] as const));
    const walk = (
      q: UseQueryResult<PageSummary[]> | undefined,
      depth: number,
      parent: string,
    ) => {
      if (!q || q.isPending)
        return void out.push({
          kind: "status",
          key: `s:${parent}`,
          text: "Loading…",
          depth,
        });
      if (q.isError && !q.data)
        return void out.push({
          kind: "status",
          key: `s:${parent}`,
          text:
            q.error instanceof OfflineError
              ? "Not available offline"
              : errorMessage(q.error),
          depth,
        });
      if (!q.data.length)
        return void out.push({
          kind: "status",
          key: `s:${parent}`,
          text: depth ? "No pages inside" : "No pages yet",
          depth,
        });
      for (const p of q.data) {
        const open = expanded.has(p.id);
        out.push({
          kind: "page",
          key: `tree:${p.id}`,
          page: p,
          depth,
          expanded: open,
          tree: true,
        });
        if (open && !p.isDatabase) walk(byParent.get(p.id), depth + 1, p.id);
      }
    };
    walk(byParent.get(null), 0, "root");
    return out;
  }, [favorites.data, recents.data, tree, parents, expanded, name, switcher]);

  const create = async () => {
    const kind = await choose("New", [
      { label: "Page", value: "page" as const },
      { label: "Database", value: "database" as const },
    ]);
    if (!kind) return;
    setCreating(true);
    try {
      if (kind === "page") {
        const page = await createPage(ws, null);
        void qc.invalidateQueries({ queryKey: keys.children(ws, null) });
        openPage(page, true);
      } else {
        const { database } = await api.createDatabase(ws, {
          id: newId("pg"),
          title: "Untitled database",
        });
        void qc.invalidateQueries({ queryKey: keys.children(ws, null) });
        openPage(
          {
            id: database.id,
            title: database.title,
            isDatabase: true,
            workspaceId: ws,
          },
          true,
        );
      }
    } catch (err) {
      Alert.alert("Couldn't create", errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const refresh = () => void qc.invalidateQueries();
  return (
    <>
      <Stack.Screen
        options={{
          title: name,
          headerRight: canWrite
            ? () => (
                <HeaderButton
                  label="New page or database"
                  glyph="＋"
                  disabled={!online || creating}
                  accessibilityHint={online ? undefined : "Needs a connection"}
                  onPress={() => void create()}
                />
              )
            : undefined,
        }}
      />
      <FlashList
        data={items}
        keyExtractor={(i) => i.key}
        getItemType={(i) => i.kind}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.grouped }}
        refreshing={false}
        onRefresh={refresh}
        ListHeaderComponent={
          online ? null : (
            <Banner
              tone="warning"
              message="You're offline. Showing pages saved on this device."
            />
          )
        }
        ListFooterComponent={<View style={{ height: 32 }} />}
        renderItem={({ item }) => (
          <HomeRow
            item={item}
            ws={ws}
            toggle={toggle}
            canWrite={canWrite && online}
          />
        )}
      />
    </>
  );
}

function HomeRow({
  item,
  ws,
  toggle,
  canWrite,
}: {
  item: Item;
  ws: string;
  toggle: (id: string) => void;
  canWrite: boolean;
}) {
  const qc = useQueryClient();
  const account = useAccount();
  switch (item.kind) {
    case "header":
      return <SectionTitle>{item.title}</SectionTitle>;
    case "nav":
      return (
        <Row
          left={
            <Icon
              name={
                item.key === "nav:search"
                  ? "search"
                  : item.key === "nav:graph"
                    ? "graph"
                    : item.key === "nav:trash"
                      ? "trash"
                      : item.key === "nav:settings"
                        ? "settings"
                        : "home"
              }
            />
          }
          title={item.title}
          detail={item.detail}
          onPress={item.onPress}
          accessibilityHint={item.hint}
          right={<Chevron />}
          testID={item.key}
        />
      );
    case "status":
      return (
        <Text
          style={{
            paddingVertical: 12,
            paddingLeft: 16 + 44 + item.depth * 16,
            color: colors.secondaryLabel,
            fontSize: 15,
            backgroundColor: colors.card,
          }}
        >
          {item.text}
        </Text>
      );
    case "page": {
      const p = item.page;
      const title = p.title || "Untitled";
      const canExpand = item.tree && p.hasChildren && !p.isDatabase;
      return (
        <Row
          testID={`page-row-${title}`}
          title={title}
          indent={item.depth}
          accessibilityLabel={`${title}${p.isDatabase ? ", database" : ""}`}
          onPress={() => openPage({ ...p, workspaceId: ws })}
          left={
            item.tree ? (
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
              >
                <Pressable
                  onPress={() => canExpand && toggle(p.id)}
                  disabled={!canExpand}
                  accessibilityRole="button"
                  accessibilityLabel={
                    canExpand
                      ? `${item.expanded ? "Collapse" : "Expand"} ${title}`
                      : undefined
                  }
                  accessibilityState={{
                    expanded: canExpand ? !!item.expanded : undefined,
                  }}
                  accessibilityElementsHidden={!canExpand}
                  importantForAccessibility={
                    canExpand ? "yes" : "no-hide-descendants"
                  }
                  hitSlop={4}
                  style={{
                    width: HIT,
                    height: HIT,
                    marginLeft: -12,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {canExpand && (
                    <Icon
                      name={item.expanded ? "chevronDown" : "chevronRight"}
                      size={16}
                    />
                  )}
                </Pressable>
                {p.icon ? (
                  <Text style={{ fontSize: 18 }}>{p.icon}</Text>
                ) : (
                  <Icon name={p.isDatabase ? "database" : "page"} />
                )}
              </View>
            ) : p.icon ? (
              <Text style={{ fontSize: 18 }}>{p.icon}</Text>
            ) : (
              <Icon name={p.isDatabase ? "database" : "page"} />
            )
          }
          right={
            canWrite && item.tree && !p.isDatabase ? (
              <HeaderButton
                label={`New subpage in ${title}`}
                icon="plus"
                onPress={() =>
                  void createPage(ws, p.id, {
                    sql: sqlOf(account),
                    scope: account.dbName,
                  })
                    .then((child) => {
                      void qc.invalidateQueries({
                        queryKey: keys.children(ws, p.id),
                      });
                      void qc.invalidateQueries({
                        queryKey: keys.hierarchy(ws),
                      });
                      openPage(child, true);
                    })
                    .catch((err: unknown) =>
                      Alert.alert("Couldn't create page", errorMessage(err)),
                    )
                }
              />
            ) : undefined
          }
        />
      );
    }
  }
}

function Chevron() {
  return <Icon name="chevronRight" size={16} />;
}

/** Signed in, but no membership yet: workspaces are invitation-only. */
function NoWorkspace({ email }: { email: string }) {
  const qc = useQueryClient();
  const signOut = useSignOut();
  const [link, setLink] = useState("");
  const token = inviteTokenFrom(link);
  return (
    <>
      <Stack.Screen options={{ title: "Workspace" }} />
      <Message
        title="You need an invitation"
        body={`Workspaces are invitation-only. Ask a workspace owner to invite ${email || "your email address"}, then open the invitation link on this device or paste it here.`}
      >
        <TextInput
          testID="invite-link"
          accessibilityLabel="Invitation link"
          placeholder="Paste invitation link"
          placeholderTextColor={colors.tertiaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          value={link}
          onChangeText={setLink}
          style={{
            alignSelf: "stretch",
            minHeight: HIT,
            borderRadius: 10,
            paddingHorizontal: 12,
            fontSize: 17,
            color: colors.label,
            backgroundColor: colors.card,
          }}
        />
        <Button
          title="Open invitation"
          disabled={!token}
          onPress={() =>
            token &&
            router.push({ pathname: "/invite/[token]", params: { token } })
          }
        />
        <Button
          kind="plain"
          title="Check again"
          onPress={() => void qc.invalidateQueries({ queryKey: ["me"] })}
        />
        <Button kind="plain" title="Sign out" onPress={() => void signOut()} />
      </Message>
    </>
  );
}
