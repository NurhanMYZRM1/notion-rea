import { ApiRequestError, can, newId, type HierarchyNode } from "@workspace/core";
import { hierarchyEdgePath, layoutHierarchy } from "@workspace/core/hierarchy";
import { workspacePalette } from "@workspace/core/design-tokens";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { G, Path, Rect, Text as SvgText } from "react-native-svg";
import { Icon } from "@/components/icon";
import {
  Banner,
  Button,
  HeaderButton,
  Loading,
  Message,
  showActions,
} from "@/components/ui";
import { api, errorMessage, isNetworkError, useOnline } from "@/lib/api";
import { kvGet, kvSet } from "@/lib/doc-store";
import { createPage, invalidatePage, keys, kv, openPage } from "@/lib/queries";
import {
  OfflineError,
  sqlOf,
  useAccount,
  useCachedOptions,
  useWorkspace,
} from "@/lib/session";
import { movePageTo } from "@/lib/subpages";
import { colors, HIT, useThemeScheme } from "@/lib/theme";

type Branch = { parentId: string | null; cursor: string | null };
export default function Graph() {
  const { current } = useWorkspace();
  if (!current) return <Message title="Choose a workspace" />;
  return (
    <HierarchyMap
      key={current.id}
      ws={current.id}
      title={current.name}
      role={current.role}
    />
  );
}
function HierarchyMap({
  ws,
  title,
  role,
}: {
  ws: string;
  title: string;
  role: "owner" | "editor" | "viewer";
}) {
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const make = useCachedOptions();
  const account = useAccount();
  const sql = sqlOf(account);
  const online = useOnline();
  const palette = workspacePalette[useThemeScheme()];
  const { width, height } = useWindowDimensions();
  const [bounds, setBounds] = useState({ width, height: height - 220 });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [pages, setPages] = useState<Branch[]>([
    { parentId: null, cursor: null },
  ]);
  const [path, setPath] = useState<HierarchyNode[]>([]);
  const [focusedPathId, setFocusedPathId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tree, setTree] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const pendingFocus = useRef<string | null>(focus ?? null);
  const didFit = useRef(false);
  const queries = useQueries({
    queries: pages.map(({ parentId, cursor }) =>
      make(
        [...keys.hierarchy(ws), parentId, cursor],
        kv.hierarchy(ws, parentId, cursor),
        () => api.hierarchy(ws, { parentId, cursor, limit: 100 }),
      ),
    ),
  });
  const nodes = useMemo(() => {
    const all = new Map(path.map((n) => [n.id, n]));
    for (const q of queries)
      for (const n of q.data?.nodes ?? []) all.set(n.id, n);
    return [...all.values()];
  }, [queries, path]);
  const rootId = `workspace:${ws}`;
  const layout = useMemo(
    () =>
      layoutHierarchy(nodes, expanded, {
        rootId,
        rootTitle: title,
        nodeWidth: 208,
        nodeHeight: 52,
        levelGap: 64,
        siblingGap: 20,
      }),
    [nodes, expanded, rootId, title],
  );
  const tx = useSharedValue(20);
  const ty = useSharedValue(20);
  const scale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const transform = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
    transformOrigin: "top left",
  }));
  const gesture = Gesture.Simultaneous(
    Gesture.Pan()
      .minDistance(6)
      .onBegin(() => {
        startX.value = tx.value;
        startY.value = ty.value;
      })
      .onUpdate((e) => {
        tx.value = startX.value + e.translationX;
        ty.value = startY.value + e.translationY;
      }),
    Gesture.Pinch()
      .onBegin(() => {
        startScale.value = scale.value;
        startX.value = tx.value;
        startY.value = ty.value;
      })
      .onUpdate((e) => {
        const next = Math.max(0.0001, Math.min(2.5, startScale.value * e.scale));
        const ratio = next / startScale.value;
        scale.value = next;
        tx.value = e.focalX - (e.focalX - startX.value) * ratio;
        ty.value = e.focalY - (e.focalY - startY.value) * ratio;
      }),
  );
  const fit = useCallback(() => {
    const next = Math.max(
      0.0001,
      Math.min(
        1,
        (bounds.width - 32) / layout.width,
        (bounds.height - 32) / layout.height,
      ),
    );
    scale.value = next;
    tx.value = (bounds.width - layout.width * next) / 2;
    ty.value = (bounds.height - layout.height * next) / 2;
  }, [bounds, layout.width, layout.height, scale, tx, ty]);
  useEffect(() => {
    if (nodes.length && !didFit.current && !pendingFocus.current) {
      didFit.current = true;
      fit();
    }
  }, [nodes.length, fit]);
  const loadBranch = (parentId: string | null, cursor: string | null = null) =>
    setPages((s) =>
      s.some((p) => p.parentId === parentId && p.cursor === cursor)
        ? s
        : [...s, { parentId, cursor }],
    );
  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(id)) {
        next.add(id);
        loadBranch(id);
      }
      return next;
    });
  const focusPage = useCallback(
    async (id: string) => {
      try {
        const cacheKey = `hierarchy-focus:${ws}:${id}`;
        let result: Awaited<ReturnType<typeof api.hierarchy>>;
        try {
          result = await api.hierarchy(ws, { focusId: id, limit: 100 });
          await kvSet(sql, cacheKey, result);
        } catch (err) {
          if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) {
            await kvSet(sql, cacheKey, null);
            setPath([]);
            setSelected(null);
            void qc.invalidateQueries({ queryKey: keys.hierarchy(ws) });
          }
          if (!isNetworkError(err)) throw err;
          const stored = await kvGet<typeof result | null>(sql, cacheKey);
          if (!stored) throw err;
          result = stored;
        }
        qc.setQueryData([...keys.hierarchy(ws), "focus", id], result);
        setFocusedPathId(id);
        setPath(result.path);
        setExpanded((s) => new Set([...s, ...result.path.map((n) => n.id)]));
        for (const n of result.path) if (n.id !== id) loadBranch(n.id);
        setSelected(id);
        pendingFocus.current = id;
        setSearch("");
        setQuery("");
        Keyboard.dismiss();
      } catch (err) {
        pendingFocus.current = null;
        Alert.alert("Couldn't focus page", errorMessage(err));
      }
    },
    [ws, sql, qc],
  );
  useEffect(() => {
    if (focus) void focusPage(focus);
  }, [focus, focusPage]);
  // Keep a searched node's ancestry live when remote moves/renames/archive invalidate hierarchy.
  const focusedPath = useQuery({
    ...make([...keys.hierarchy(ws), "focus", focusedPathId], focusedPathId ? `hierarchy-focus:${ws}:${focusedPathId}` : null, () => api.hierarchy(ws, { focusId: focusedPathId!, limit: 100 })),
    enabled: !!focusedPathId,
  });
  useEffect(() => {
    if (!focusedPath.data) return;
    setPath(focusedPath.data.path);
    setExpanded((s) => new Set([...s, ...focusedPath.data!.path.map((n) => n.id)]));
    for (const node of focusedPath.data.path) if (node.id !== focusedPathId) loadBranch(node.id);
  }, [focusedPath.data, focusedPathId]);
  useEffect(() => {
    if (!(focusedPath.error instanceof ApiRequestError) || ![403, 404].includes(focusedPath.error.status)) return;
    if (focusedPathId) void kvSet(sql, `hierarchy-focus:${ws}:${focusedPathId}`, null);
    setPath([]); setSelected(null); setFocusedPathId(null);
  }, [focusedPath.error, focusedPathId, sql, ws]);

  useEffect(() => {
    const id = pendingFocus.current;
    const node = layout.nodes.find((n) => n.id === id);
    if (!node) return;
    scale.value = 0.85;
    tx.value = bounds.width / 2 - (node.x + node.width / 2) * 0.85;
    ty.value = bounds.height / 2 - (node.y + node.height / 2) * 0.85;
    pendingFocus.current = null;
    didFit.current = true;
    AccessibilityInfo.announceForAccessibility(
      `Focused ${node.node?.title || "Untitled"}`,
    );
  }, [layout, bounds, tx, ty, scale]);
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const results = useQuery({
    queryKey: ["graph-search", ws, query],
    queryFn: () => api.search(ws, query),
    enabled: query.length > 0,
  });
  const act = (node: HierarchyNode) => {
    setSelected(node.id);
    showActions({
      title: node.title || "Untitled",
      actions: [
        { label: "Open", onPress: () => openPage(node) },
        ...(can(role, "write") && online
          ? [
              {
                label: node.isDatabase ? "New record" : "New subpage",
                onPress: () =>
                  void (async () => {
                    const createdId = node.isDatabase
                      ? (await api.createRecord(node.id, {}, newId("pg")))
                          .record.id
                      : (
                          await createPage(ws, node.id, {
                            sql,
                            scope: account.dbName,
                          })
                        ).id;
                    const child = (await api.page(createdId)).page;
                    invalidatePage(qc, child);
                    openPage(child, true);
                  })().catch((err: unknown) =>
                    Alert.alert("Couldn't create page", errorMessage(err)),
                  ),
              },
            ]
          : []),
        ...(can(role, "write") && online && !node.databaseId
          ? [
              {
                label: "Move to…",
                onPress: () =>
                  void movePageTo(qc, node.id).catch((err: unknown) =>
                    Alert.alert("Couldn't move page", errorMessage(err)),
                  ),
              },
            ]
          : []),
        ...(node.hasChildren
          ? [
              {
                label: expanded.has(node.id)
                  ? "Collapse branch"
                  : "Expand branch",
                onPress: () => toggle(node.id),
              },
            ]
          : []),
      ],
    });
  };
  const loadMore = pages.flatMap((branch, i) =>
    queries[i]?.data?.nextCursor &&
    (branch.parentId === null || expanded.has(branch.parentId)) &&
    !pages.some(
      (p) =>
        p.parentId === branch.parentId &&
        p.cursor === queries[i]?.data?.nextCursor,
    )
      ? [{ ...branch, cursor: queries[i]!.data!.nextCursor! }]
      : [],
  );
  if (queries[0]?.isPending) return <Loading label="Loading hierarchy" />;
  if (queries[0]?.isError && !queries[0]?.data)
    return (
      <Message
        title={
          queries[0].error instanceof OfflineError
            ? "Graph not available offline"
            : "Couldn't load Graph"
        }
        body={errorMessage(queries[0].error)}
      >
        <Button
          title="Try again"
          kind="plain"
          onPress={() => void queries[0]?.refetch()}
        />
      </Message>
    );
  return (
    <GestureHandlerRootView
      style={{ flex: 1, paddingTop: Platform.OS === "ios" ? headerHeight : 0, backgroundColor: colors.background }}
    >
      <Stack.Screen options={{ title: "Graph" }} />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          margin: 12,
          paddingHorizontal: 12,
          backgroundColor: colors.fill,
          borderRadius: 6,
        }}
      >
        <Icon name="search" size={18} />
        <TextInput
          accessibilityLabel="Search and focus a page"
          placeholder="Search pages…"
          placeholderTextColor={colors.tertiaryLabel}
          value={search}
          onChangeText={setSearch}
          style={{ minHeight: HIT, flex: 1, color: colors.label, fontSize: 16 }}
          returnKeyType="search"
        />
        <HeaderButton label={tree ? "Show map" : "Accessible tree"} icon={tree ? "graph" : "tree"} onPress={() => setTree((v) => !v)} />
      </View>
      {!online && (
        <Banner
          tone="warning"
          message="Offline. Showing cached hierarchy. Page changes need a connection."
        />
      )}
      {query ? (
        <FlatList
          keyboardShouldPersistTaps="handled"
          data={results.data?.results ?? []}
          keyExtractor={(n) => n.pageId}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Focus ${item.title || "Untitled"} in Graph`}
              testID={`graph-search-result-${item.pageId}`}
              onPress={() => { Keyboard.dismiss(); void focusPage(item.pageId); }}
              style={{ minHeight: HIT, padding: 16 }}
            >
              <Text style={{ color: colors.label }}>
                {item.title || "Untitled"}
              </Text>
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={{ padding: 24, color: colors.secondaryLabel }}>
              {results.isPending
                ? "Searching…"
                : results.isError
                  ? errorMessage(results.error)
                  : "No pages found"}
            </Text>
          }
        />
      ) : tree ? (
        <FlatList
          data={layout.nodes}
          keyExtractor={(n) => n.id}
          contentContainerStyle={{ paddingBottom: Math.max(24, insets.bottom) }}
          renderItem={({ item }) => (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingLeft: 8 + item.depth * 20,
              }}
            >
              {item.node?.hasChildren ? <HeaderButton
                label={`${expanded.has(item.id) ? "Collapse" : "Expand"} ${item.node?.title || (item.node ? "Untitled" : title)}`}
                icon={
                  expanded.has(item.id) || !item.node
                    ? "chevronDown"
                    : "chevronRight"
                }
                disabled={!item.node?.hasChildren}
                onPress={() => toggle(item.id)}
              /> : <View style={{ width: HIT }} />}
              <Pressable
                accessibilityRole={item.node ? "button" : "header"}
                accessibilityState={{
                  selected: selected === item.id,
                  expanded: item.node?.hasChildren
                    ? expanded.has(item.id)
                    : undefined,
                }}
                accessibilityLabel={`${item.node?.title || (item.node ? "Untitled" : title)}, ${item.node?.kind ?? "workspace"}, level ${item.depth + 1}`}
                accessibilityActions={
                  item.node?.hasChildren
                    ? [
                        { name: "expand", label: "Expand branch" },
                        { name: "collapse", label: "Collapse branch" },
                      ]
                    : undefined
                }
                onAccessibilityAction={(event) => { const shouldExpand = event.nativeEvent.actionName === "expand"; if (shouldExpand !== expanded.has(item.id)) toggle(item.id); }}
                onPress={item.node ? () => act(item.node!) : undefined}
                style={{
                  minHeight: HIT,
                  flex: 1,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingRight: 16,
                }}
              >
                <Icon
                  name={
                    item.node?.isDatabase
                      ? "database"
                      : item.node
                        ? "page"
                        : "home"
                  }
                />
                <Text style={{ color: colors.label, flex: 1, fontSize: 16 }}>
                  {item.node?.title || (item.node ? "Untitled" : title)}
                </Text>
              </Pressable>
            </View>
          )}
        />
      ) : (
        <View
          style={{ flex: 1, overflow: "hidden" }}
          onLayout={(e) => setBounds(e.nativeEvent.layout)}
        >
          <GestureDetector gesture={gesture}>
            <Animated.View
              style={{ flex: 1 }}
              accessible
              accessibilityLabel="Workspace hierarchy map. Drag to pan, pinch to zoom. Use Accessible tree for keyboard and screen reader navigation."
            >
              <Animated.View
                style={[
                  {
                    position: "absolute",
                    width: layout.width,
                    height: layout.height,
                  },
                  transform,
                ]}
              >
                <Svg
                  width={layout.width}
                  height={layout.height}
                  accessible={false}
                >
                  {layout.edges.map((e) => (
                    <Path
                      key={e.id}
                      d={hierarchyEdgePath(e)}
                      stroke={palette.border}
                      strokeWidth={1.5}
                      fill="none"
                    />
                  ))}
                  {layout.nodes.map((n) => (
                    <G
                      key={n.id}
                      onPress={() => (n.node ? act(n.node) : fit())}
                    >
                      <Rect
                        x={n.x}
                        y={n.y}
                        width={n.width}
                        height={n.height}
                        rx={6}
                        fill={
                          n.id === selected ? palette.active : palette.surface
                        }
                        stroke={
                          n.id === selected ? palette.accent : palette.border
                        }
                      />
                      <SvgText
                        x={n.x + 14}
                        y={n.y + 31}
                        fill={palette.foreground}
                        fontSize={14}
                        fontWeight={n.node ? "400" : "600"}
                      >
                        {(n.node?.title || (n.node ? "Untitled" : title)).slice(
                          0,
                          22,
                        )}
                        {(n.node?.title?.length ?? 0) > 22 ? "…" : ""}
                      </SvgText>
                      {n.node?.hasChildren && (
                        <G onPress={() => toggle(n.id)}>
                          <Rect
                            x={n.x + n.width - 32}
                            y={n.y + 8}
                            width={32}
                            height={36}
                            fill={palette.surface}
                          />
                          <SvgText
                            x={n.x + n.width - 23}
                            y={n.y + 31}
                            fill={palette.muted}
                            fontSize={20}
                          >
                            {expanded.has(n.id) ? "−" : "+"}
                          </SvgText>
                        </G>
                      )}
                    </G>
                  ))}
                </Svg>
              </Animated.View>
            </Animated.View>
          </GestureDetector>
          <View
            style={{
              position: "absolute",
              bottom: Math.max(16, insets.bottom + 8),
              right: 12,
              flexDirection: "row",
              borderWidth: 1,
              borderColor: colors.separator,
              backgroundColor: colors.card,
              borderRadius: 6,
            }}
          >
            <HeaderButton
              label="Zoom out"
              icon="zoomOut"
              onPress={() => {
                scale.value = Math.max(0.0001, scale.value / 1.25);
              }}
            />
            <HeaderButton label="Fit to view" icon="fit" onPress={fit} />
            <HeaderButton
              label="Zoom in"
              icon="zoomIn"
              onPress={() => {
                scale.value = Math.min(2.5, scale.value * 1.25);
              }}
            />
          </View>
        </View>
      )}
      {!!loadMore.length && !query && (
        <Button
          kind="plain"
          title={`Load more ${loadMore[0]?.parentId ? "children" : "pages"}`}
          onPress={() => loadBranch(loadMore[0]!.parentId, loadMore[0]!.cursor)}
        />
      )}
    </GestureHandlerRootView>
  );
}
