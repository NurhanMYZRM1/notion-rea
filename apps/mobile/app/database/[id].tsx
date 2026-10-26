import { can, type DatabaseInfo, FILTER_OPS, type Filter, newId, type PropertyDef, type PropertyValue, type RecordRow, type Sort, type ViewConfig, type ViewInfo } from "@workspace/core";
import { FlashList } from "@shopify/flash-list";
import { type QueryClient, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useState } from "react";
import { Alert, FlatList, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { editProperty, formatValue, saveRecordValues } from "@/components/properties";
import { Banner, Button, choose, HeaderButton, Loading, Message, prompt } from "@/components/ui";
import { api, conflictCurrent, errorMessage, useOnline } from "@/lib/api";
import { keys, kv, openPage } from "@/lib/queries";
import { OfflineError, useCachedQuery, useWorkspace } from "@/lib/session";
import { colors, HIT } from "@/lib/theme";

const OP_LABEL: Record<string, string> = {
  contains: "contains",
  not_contains: "doesn't contain",
  equals: "is",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  on: "is on",
  before: "is before",
  after: "is after",
  is: "is",
  is_not: "is not",
};
const PAGE_SIZE = 50;

/** Save a view config at its revision; on 409 re-apply ours (the user's latest choice) once. */
async function saveView(qc: QueryClient, databaseId: string, view: ViewInfo, config: ViewConfig) {
  let revision = view.revision;
  for (let attempt = 0; ; attempt++) {
    try {
      const { view: saved } = await api.updateView(databaseId, view.id, { expectedRevision: revision, config });
      qc.setQueryData<DatabaseInfo>(keys.database(databaseId), (d) => (d ? { ...d, views: d.views.map((v) => (v.id === saved.id ? saved : v)) } : d));
      return;
    } catch (err) {
      const current = conflictCurrent<ViewInfo>(err);
      if (!current || attempt > 0) throw err;
      revision = current.revision;
    }
  }
}

function describeFilter(schema: PropertyDef[], f: Filter | undefined): string {
  if (!f) return "Filter";
  const def = schema.find((p) => p.id === f.propId);
  if (!def) return "Filter";
  const value = f.op === "is_empty" || f.op === "is_not_empty" ? "" : ` ${formatValue(def, (f.value ?? null) as PropertyValue)}`;
  return `${def.name} ${OP_LABEL[f.op] ?? f.op}${value}`;
}
function describeSort(schema: PropertyDef[], s: Sort | undefined): string {
  if (!s) return "Sort";
  const name = s.propId === "created_at" ? "Created" : (schema.find((p) => p.id === s.propId)?.name ?? "Sort");
  return `${name} ${s.direction === "asc" ? "↑" : "↓"}`;
}

export default function DatabaseScreen() {
  const params = useLocalSearchParams<{ id: string; title?: string; ws?: string }>();
  const id = params.id;
  const qc = useQueryClient();
  const online = useOnline();
  const { me } = useWorkspace();
  const db = useCachedQuery(keys.database(id), kv.database(id), () => api.database(id).then((r) => r.database));
  const page = useCachedQuery(keys.page(id), kv.page(id), () => api.page(id).then((r) => r.page));
  const [viewId, setViewId] = useState<string | null>(null);
  const headerHeight = useHeaderHeight();
  const database = db.data;
  const view = database?.views.find((v) => v.id === viewId) ?? database?.views[0];
  const filters = view?.config.filters ?? [];
  const sorts = view?.config.sorts ?? [];
  const rows = useInfiniteQuery({
    queryKey: keys.rows(id, view?.id, filters, sorts),
    queryFn: ({ pageParam }) => api.query(id, { filters, sorts, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!view,
    retry: 1,
  });

  if (!database || !view) {
    if (db.isPending) return <Loading label="Loading database" />;
    return <Message title={db.error instanceof OfflineError ? "Not available offline" : "Couldn't open database"} body={db.isError ? errorMessage(db.error) : "This database has no views."} />;
  }
  const ws = page.data?.workspaceId ?? database.workspaceId;
  const role = me.data?.workspaces.find((w) => w.id === ws)?.role;
  const active = (page.data?.state ?? "active") === "active";
  const canWrite = can(role, "write") && active;
  const canChange = canWrite && online;
  const records = rows.data?.pages.flatMap((p) => p.records) ?? [];
  const schema = database.schema;
  const more = () => rows.hasNextPage && !rows.isFetchingNextPage && void rows.fetchNextPage();

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      Alert.alert(label, errorMessage(err));
    }
  };
  const setConfig = (config: ViewConfig) => run("Couldn't save the view", () => saveView(qc, id, view, config));

  const editFilter = async () => {
    const pick = await choose("Filter by", [...schema.map((p) => ({ label: p.name, value: p.id })), ...(filters.length ? [{ label: "Remove filter", value: "", destructive: true }] : [])]);
    if (pick === undefined) return;
    if (pick === "") return setConfig({ ...view.config, filters: [] });
    const def = schema.find((p) => p.id === pick)!;
    const op = await choose(def.name, FILTER_OPS[def.type].map((o) => ({ label: `${def.name} ${OP_LABEL[o] ?? o}`, value: o as string })));
    if (!op) return;
    let value: PropertyValue | undefined = null;
    if (op !== "is_empty" && op !== "is_not_empty") {
      if (def.type === "checkbox") value = await choose(def.name, [{ label: "Checked", value: true }, { label: "Unchecked", value: false }]);
      else if (def.type === "select" || def.type === "status") value = await choose(def.name, (def.options ?? []).map((o) => ({ label: o.name, value: o.id })));
      else if (def.type === "number" || def.type === "date") value = await editProperty(def, null);
      else value = (await prompt({ title: `${def.name} ${OP_LABEL[op] ?? op}`, placeholder: "Text" }))?.trim() || undefined;
      if (value === undefined || value === null) return;
    }
    await setConfig({ ...view.config, filters: [{ propId: def.id, op, value }] });
  };
  const editSort = async () => {
    const pick = await choose("Sort by", [
      ...schema.map((p) => ({ label: p.name, value: p.id })),
      { label: "Created", value: "created_at" },
      ...(sorts.length ? [{ label: "Remove sort", value: "", destructive: true }] : []),
    ]);
    if (pick === undefined) return;
    if (pick === "") return setConfig({ ...view.config, sorts: [] });
    const direction = await choose("Order", [
      { label: "Ascending", value: "asc" as const },
      { label: "Descending", value: "desc" as const },
    ]);
    if (direction) await setConfig({ ...view.config, sorts: [{ propId: pick, direction }] });
  };
  const addRow = (values: Record<string, PropertyValue> = {}) =>
    run("Couldn't add a row", async () => {
      const { record } = await api.createRecord(id, values, newId("pg"));
      void qc.invalidateQueries({ queryKey: keys.database(id) });
      openPage({ id: record.id, title: record.title, isDatabase: false, workspaceId: ws }, true);
    });
  const editCell = async (record: RecordRow, def: PropertyDef) => {
    const next = await editProperty(def, record.values[def.id]);
    if (next !== undefined) await run(`Couldn't save ${def.name}`, () => saveRecordValues(qc, record, id, { [def.id]: next }));
  };

  return (
    <View style={{ flex: 1, paddingTop: headerHeight, backgroundColor: colors.grouped }}>
      <Stack.Screen
        options={{
          title: database.title || "Untitled database",
          headerRight: canWrite ? () => <HeaderButton label="Add row" glyph="＋" disabled={!online} accessibilityHint={online ? undefined : "Needs a connection"} onPress={() => void addRow()} /> : undefined,
        }}
      />
      {!online && <Banner tone="warning" message="You're offline. Changes to this database need a connection." />}
      {!active && <Banner tone="warning" message="This database is in the trash. It's read-only until restored." />}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 8, paddingVertical: 8 }}>
        <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 8 }}>
          {database.views.map((v) => (
            <Chip key={v.id} label={`${v.type === "board" ? "▦" : "☰"} ${v.name}`} a11y={`${v.name} ${v.type} view`} role="tab" selected={v.id === view.id} onPress={() => setViewId(v.id)} />
          ))}
        </View>
        <Chip label={describeFilter(schema, filters[0]) + (filters.length > 1 ? ` +${filters.length - 1}` : "")} a11y={`Filter: ${filters.length ? describeFilter(schema, filters[0]) : "none"}`} selected={!!filters.length} disabled={!canChange} onPress={() => void editFilter()} />
        <Chip label={describeSort(schema, sorts[0])} a11y={`Sort: ${sorts.length ? describeSort(schema, sorts[0]) : "none"}`} selected={!!sorts.length} disabled={!canChange} onPress={() => void editSort()} />
      </ScrollView>
      {rows.isPending ? (
        <Loading label="Loading rows" />
      ) : rows.isError && !records.length ? (
        <Message title="Couldn't load rows" body={errorMessage(rows.error)}>
          <Button kind="plain" title="Try again" onPress={() => void rows.refetch()} />
        </Message>
      ) : view.type === "board" ? (
        <Board view={view} schema={schema} records={records} canEdit={canChange} onEndReached={more} onAdd={(values) => void addRow(values)} onOpen={(r) => openPage({ ...r, isDatabase: false, workspaceId: ws })} onMove={(r, def, value) => void run("Couldn't move the card", () => saveRecordValues(qc, r, id, { [def.id]: value }))} onGroup={(propId) => void setConfig({ ...view.config, groupBy: propId })} />
      ) : (
        <FlashList
          data={records}
          keyExtractor={(r) => r.id}
          onEndReached={more}
          onEndReachedThreshold={0.5}
          refreshing={rows.isRefetching && !rows.isFetchingNextPage}
          onRefresh={() => void rows.refetch()}
          ItemSeparatorComponent={() => <View style={{ height: 1, marginLeft: 16, backgroundColor: colors.separator }} />}
          ListEmptyComponent={<Message title="No rows" body={filters.length ? "Nothing matches this filter." : canWrite ? "Add a row with ＋." : undefined} />}
          ListFooterComponent={rows.isFetchingNextPage ? <Loading label="Loading more rows" /> : <View style={{ height: 32 }} />}
          renderItem={({ item }) => <TableRow record={item} schema={schema} hidden={view.config.hiddenProps} canEdit={canChange} onOpen={() => openPage({ ...item, isDatabase: false, workspaceId: ws })} onEdit={(def) => void editCell(item, def)} />}
        />
      )}
    </View>
  );
}

function Chip(p: { label: string; a11y: string; selected?: boolean; disabled?: boolean; role?: "tab"; onPress: () => void }) {
  return (
    <Pressable
      onPress={p.onPress}
      disabled={p.disabled}
      accessibilityRole={p.role ?? "button"}
      accessibilityLabel={p.a11y}
      accessibilityState={{ selected: !!p.selected, disabled: !!p.disabled }}
      style={({ pressed }) => ({ minHeight: HIT, paddingHorizontal: 14, borderRadius: HIT / 2, justifyContent: "center", backgroundColor: p.selected ? colors.tint : colors.card, opacity: p.disabled ? 0.5 : pressed ? 0.7 : 1 })}
    >
      <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "600", color: p.selected ? colors.onTint : colors.label }}>
        {p.label}
      </Text>
    </Pressable>
  );
}

/** Title + up to three key properties; the title opens the record, each property is tap-to-edit. */
function TableRow(p: { record: RecordRow; schema: PropertyDef[]; hidden: string[]; canEdit: boolean; onOpen: () => void; onEdit: (def: PropertyDef) => void }) {
  const props = p.schema.filter((d) => d.type !== "title" && !p.hidden.includes(d.id)).slice(0, 3);
  const title = p.record.title || "Untitled";
  return (
    <View style={{ backgroundColor: colors.card, paddingVertical: 6 }}>
      <Pressable onPress={p.onOpen} accessibilityRole="button" accessibilityLabel={`Open ${title}`} style={({ pressed }) => ({ minHeight: HIT, justifyContent: "center", paddingHorizontal: 16, opacity: pressed ? 0.6 : 1 })}>
        <Text numberOfLines={2} style={{ fontSize: 17, fontWeight: "600", color: colors.label }}>
          {title}
        </Text>
      </Pressable>
      {!!props.length && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 12 }}>
          {props.map((def) => {
            const text = formatValue(def, p.record.values[def.id]);
            return (
              <Pressable
                key={def.id}
                onPress={p.canEdit ? () => p.onEdit(def) : undefined}
                disabled={!p.canEdit}
                accessibilityRole={p.canEdit ? "button" : "text"}
                accessibilityLabel={`${def.name}: ${text || "empty"}`}
                accessibilityHint={p.canEdit ? "Double-tap to edit" : undefined}
                style={({ pressed }) => ({ minHeight: HIT, justifyContent: "center", paddingHorizontal: 10, borderRadius: 8, borderCurve: "continuous", backgroundColor: colors.fill, opacity: pressed ? 0.6 : 1, maxWidth: "100%" })}
              >
                <Text numberOfLines={1} style={{ fontSize: 14, color: text ? colors.label : colors.tertiaryLabel }}>
                  <Text style={{ color: colors.secondaryLabel }}>{def.name} </Text>
                  {text || "—"}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

/** Horizontally paged columns, one per option of the group-by property, plus "No <property>". */
function Board(p: {
  view: ViewInfo;
  schema: PropertyDef[];
  records: RecordRow[];
  canEdit: boolean;
  onEndReached: () => void;
  onAdd: (values: Record<string, PropertyValue>) => void;
  onOpen: (r: RecordRow) => void;
  onMove: (r: RecordRow, def: PropertyDef, value: PropertyValue) => void;
  onGroup: (propId: string) => void;
}) {
  const { width } = useWindowDimensions();
  const def = p.schema.find((d) => d.id === p.view.config.groupBy && (d.type === "select" || d.type === "status"));
  if (!def) {
    const groupable = p.schema.filter((d) => d.type === "select" || d.type === "status");
    return (
      <Message title="Board isn't grouped" body={groupable.length ? "Choose a select or status property to make columns." : "Add a select or status property on the web to use a board."}>
        {p.canEdit && !!groupable.length && <Button title="Group by…" onPress={() => void choose("Group by", groupable.map((g) => ({ label: g.name, value: g.id }))).then((v) => v && p.onGroup(v))} />}
      </Message>
    );
  }
  const columns: { id: string | null; name: string }[] = [...(def.options ?? []).map((o) => ({ id: o.id, name: o.name })), { id: null, name: `No ${def.name}` }];
  const colWidth = Math.min(width - 48, 420);
  const move = async (r: RecordRow) => {
    const to = await choose(`Move “${r.title || "Untitled"}” to…`, columns.filter((c) => c.id !== (r.values[def.id] ?? null)).map((c) => ({ label: c.name, value: c.id ?? "" })));
    if (to !== undefined) p.onMove(r, def, to || null);
  };
  return (
    <FlatList
      horizontal
      data={columns}
      keyExtractor={(c) => c.id ?? "none"}
      snapToInterval={colWidth + 12}
      decelerationRate="fast"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 12, gap: 12, paddingBottom: 12 }}
      renderItem={({ item: col }) => {
        const cards = p.records.filter((r) => (r.values[def.id] ?? null) === col.id);
        return (
          <View accessibilityRole="list" accessibilityLabel={`${col.name}, ${cards.length} cards`} style={{ width: colWidth, borderRadius: 14, borderCurve: "continuous", backgroundColor: colors.fill, padding: 8, gap: 8 }}>
            <Text accessibilityRole="header" style={{ fontSize: 15, fontWeight: "700", color: colors.label, paddingHorizontal: 4, paddingTop: 4 }}>
              {col.name} <Text style={{ color: colors.secondaryLabel, fontWeight: "400" }}>{cards.length}</Text>
            </Text>
            <FlatList
              data={cards}
              keyExtractor={(r) => r.id}
              onEndReached={p.onEndReached}
              onEndReachedThreshold={0.5}
              contentContainerStyle={{ gap: 8 }}
              renderItem={({ item: r }) => (
                <View style={{ borderRadius: 10, borderCurve: "continuous", backgroundColor: colors.card, padding: 4 }}>
                  <Pressable onPress={() => p.onOpen(r)} accessibilityRole="button" accessibilityLabel={`Open ${r.title || "Untitled"}`} style={({ pressed }) => ({ minHeight: HIT, justifyContent: "center", paddingHorizontal: 8, opacity: pressed ? 0.6 : 1 })}>
                    <Text numberOfLines={3} style={{ fontSize: 16, color: colors.label }}>
                      {r.title || "Untitled"}
                    </Text>
                  </Pressable>
                  {p.canEdit && <Button kind="plain" title="Move to…" accessibilityHint={`Changes ${def.name}`} onPress={() => void move(r)} style={{ alignSelf: "flex-start", paddingHorizontal: 8 }} />}
                </View>
              )}
              ListFooterComponent={p.canEdit ? <Button kind="plain" title="New card" accessibilityHint={`Adds a row in ${col.name}`} onPress={() => p.onAdd(col.id ? { [def.id]: col.id } : {})} style={{ alignSelf: "flex-start" }} /> : undefined}
            />
          </View>
        );
      }}
    />
  );
}
