import {
  ApiRequestError,
  can,
  type PageDetail,
  type PageSummary,
  type RecordRow,
} from "@workspace/core";
import { useQueryClient } from "@tanstack/react-query";
import { Redirect, router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { DocEditor } from "@/components/doc-editor";
import { RecordProperties } from "@/components/properties";
import {
  Banner,
  Button,
  HeaderButton,
  Loading,
  Message,
  showActions,
  type SheetAction,
  StatusPill,
  showToast,
} from "@/components/ui";
import { api, conflictCurrent, errorMessage, useOnline } from "@/lib/api";
import {
  type DocSession,
  type DocView,
  useDocSession,
  useDocView,
} from "@/lib/doc-session";
import { openDoc } from "@/lib/doc-store";
import { docMarkdown, shareMarkdown } from "@/lib/export";
import { invalidatePage, keys, kv, openPage } from "@/lib/queries";
import {
  OfflineError,
  sqlOf,
  useAccount,
  useCachedQuery,
  useSession,
  useWorkspace,
} from "@/lib/session";
import { perfMark } from "@/lib/perf";
import { movePageTo, useChildPages } from "@/lib/subpages";
import { colors, useThemeScheme } from "@/lib/theme";

/** Stable per-user caret color (same idea as the web app). */
function userColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 65%, 45%)`;
}

/** Page and record screen: native header (title, status, banners, record properties) over the editor. */
export default function PageScreen() {
  useThemeScheme();
  const params = useLocalSearchParams<{
    id: string;
    title?: string;
    ws?: string;
    new?: string;
  }>();
  const id = params.id;
  const opened = useRef(Date.now());
  const account = useAccount();
  const { me } = useWorkspace();
  const pageQ = useCachedQuery(keys.page(id), kv.page(id), () =>
    api.page(id).then((r) => r.page),
  );
  const page = pageQ.data;
  const ws = page?.workspaceId ?? (params.ws || null);
  const isDoc = page ? !page.isDatabase : !!params.ws;
  const session = useDocSession(
    sqlOf(account),
    id,
    isDoc ? ws : null,
    page?.title ?? params.title ?? "",
  );
  const view = useDocView(session);
  const cached = useRef(false);
  cached.current = view.cached;
  // Stable: a new callback would re-render the DOM component (and re-send its props) on every sync tick.
  const onEditorReady = useCallback(
    () =>
      perfMark(
        `open-to-editable ${Date.now() - opened.current}ms page=${id} cached=${cached.current}`,
      ),
    [id],
  );

  const qc = useQueryClient();
  useEffect(() => {
    if (!ws) return;
    api
      .visit(id)
      .then(() => qc.invalidateQueries({ queryKey: keys.recents(ws) }))
      .catch(() => {});
  }, [id, ws, qc]);

  if (page?.isDatabase)
    return (
      <Redirect
        href={{
          pathname: "/database/[id]",
          params: { id, title: page.title, ws: page.workspaceId },
        }}
      />
    );
  if (!page) {
    if (pageQ.isPending) return <Loading label="Loading page" />;
    const err = pageQ.error;
    if (err instanceof OfflineError)
      return (
        <Message
          title="Not available offline"
          body="This page hasn't been opened on this device yet. It will load when you're back online."
        />
      );
    return (
      <Message
        title="Page not found"
        body={
          err instanceof ApiRequestError && err.status === 404
            ? "It may have been deleted, or you don't have access."
            : errorMessage(err)
        }
      />
    );
  }
  const role =
    me.data?.workspaces.find((w) => w.id === page.workspaceId)?.role ?? null;
  return (
    <PageBody
      page={page}
      role={role}
      session={session}
      view={view}
      isNew={params.new === "1"}
      userId={account.user.id}
      userName={account.user.name || account.user.email}
      onEditorReady={onEditorReady}
    />
  );
}

function PageBody(p: {
  page: PageDetail;
  role: "owner" | "editor" | "viewer" | null;
  session: DocSession | null;
  view: DocView;
  isNew: boolean;
  userId: string;
  userName: string;
  onEditorReady: () => void;
}) {
  const { page, view, session } = p;
  const qc = useQueryClient();
  const childPages = useChildPages(page, session, p.role);
  const online = useOnline();
  const { expire } = useSession();
  const user = useMemo(
    () => ({ name: p.userName, color: userColor(p.userId) }),
    [p.userName, p.userId],
  );
  const active = page.state === "active";
  const canWrite = can(p.role, "write");
  const canArchive = can(p.role, "archive");
  const failure = view.sync.failure;
  const editable = canWrite && active && !view.sync.readOnly && !failure;
  const headerHeight = useHeaderHeight(); // the iOS 26 nav bar is translucent and overlaps the screen

  useEffect(() => {
    if (failure === "unauthenticated") expire();
  }, [failure, expire]);

  const exportMd = async () => {
    try {
      await shareMarkdown(
        page.title,
        session
          ? docMarkdown(session.doc, page.title)
          : (await api.exportMarkdown(page.id)).markdown,
      );
    } catch (err) {
      Alert.alert("Couldn't export", errorMessage(err));
    }
  };
  const trash = async () => {
    try {
      await session?.provider.awaitSynced();
      await api.archivePage(page.id);
      invalidatePage(qc, page);
      AccessibilityInfo.announceForAccessibility("Moved to trash");
      showToast("Page moved to Trash", async () => {
        await api.restorePage(page.id);
        invalidatePage(qc, page);
      });
      router.back();
    } catch (err) {
      Alert.alert("Couldn't move to trash", errorMessage(err));
    }
  };
  const restore = async () => {
    try {
      await api.restorePage(page.id);
      invalidatePage(qc, page);
    } catch (err) {
      const root =
        err instanceof ApiRequestError
          ? (err.details as { archiveRoot?: string } | undefined)?.archiveRoot
          : undefined;
      Alert.alert(
        "Couldn't restore",
        root
          ? "This page was trashed with its parent. Restore the parent page from Trash instead."
          : errorMessage(err),
      );
    }
  };
  const subpage = async () => {
    try {
      const child = await childPages.create({});
      childPages.open(child.id);
    } catch (err) {
      Alert.alert("Couldn't create page", errorMessage(err));
    }
  };
  const more = () => {
    const actions: (SheetAction | false)[] = [
      {
        label: "Comments",
        onPress: () =>
          router.push({
            pathname: "/page/[id]/comments",
            params: { id: page.id },
          }),
      },
      { label: "Export Markdown", onPress: () => void exportMd() },
      {
        label: "Show this page in Graph",
        onPress: () =>
          router.push({
            pathname: "/graph",
            params: { focus: page.id, ws: page.workspaceId },
          }),
      },
      editable &&
        online &&
        !page.databaseId && {
          label: "Move to…",
          onPress: () =>
            void movePageTo(qc, page.id).catch((err: unknown) =>
              Alert.alert("Couldn't move page", errorMessage(err)),
            ),
        },
      editable &&
        online && { label: "New subpage", onPress: () => void subpage() },
      canArchive &&
        active &&
        online && {
          label: "Move to trash",
          destructive: true,
          onPress: () => void trash(),
        },
    ];
    showActions({
      title: page.title || "Untitled",
      actions: actions.filter((a): a is SheetAction => !!a),
    });
  };

  // Header options change only with what they show; sync ticks while typing must not touch the nav bar.
  const moreRef = useRef(more);
  moreRef.current = more;
  const headerOptions = useMemo(
    () => ({
      title: "",
      headerRight: () => (
        <View style={{ flexDirection: "row" }}>
          <FavoriteButton page={page} online={online} />
          <HeaderButton
            label="Page actions"
            glyph="⋯"
            onPress={() => moreRef.current()}
          />
        </View>
      ),
    }),
    [page, online],
  );

  const banner =
    failure === "upgrade-required" ? (
      <Banner
        tone="warning"
        message="Update Workspace to edit this page. It uses a newer document format. Your saved edits stay on this device."
        actions={[{ label: "Export draft", onPress: () => void exportMd() }]}
      />
    ) : failure === "revoked" ||
      failure === "deleted" ||
      failure === "error" ? (
      <Banner
        tone="danger"
        message={
          failure === "revoked"
            ? "You no longer have access to this page. Edits that hadn't synced are kept on this device."
            : failure === "deleted"
              ? "This page was deleted. Edits that hadn't synced are kept on this device."
              : "The server couldn't open this page. Your edits are kept on this device."
        }
        actions={[{ label: "Export draft", onPress: () => void exportMd() }]}
      />
    ) : !active ? (
      <Banner
        tone="warning"
        message="This page is in the trash. It's read-only until restored."
        actions={
          canArchive && online
            ? [{ label: "Restore", onPress: () => void restore() }]
            : undefined
        }
      />
    ) : view.sync.readOnly === "viewer" || (p.role === "viewer" && !failure) ? (
      <Banner tone="info" message="You can view this page but not edit it." />
    ) : null;

  return (
    <View
      style={{
        flex: 1,
        paddingTop: Platform.OS === "ios" ? headerHeight : 0,
        backgroundColor: colors.background,
      }}
    >
      <Stack.Screen options={headerOptions} />
      <ScrollView
        style={{ flexGrow: 0, maxHeight: "50%" }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 4 }}
      >
        {!!page.breadcrumbs.length && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: 16,
              alignItems: "center",
              gap: 4,
            }}
          >
            {page.breadcrumbs.map((crumb, i) => (
              <View
                key={crumb.id}
                style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
              >
                {i > 0 && (
                  <Text style={{ color: colors.tertiaryLabel }}>/</Text>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${crumb.title || "Untitled"}`}
                  onPress={() =>
                    void api
                      .page(crumb.id)
                      .then(({ page: ancestor }) => openPage(ancestor))
                      .catch((err: unknown) =>
                        Alert.alert("Couldn't open page", errorMessage(err)),
                      )
                  }
                  style={{
                    minHeight: 44,
                    justifyContent: "center",
                    paddingHorizontal: 4,
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={{
                      maxWidth: 180,
                      fontSize: 13,
                      color: colors.secondaryLabel,
                    }}
                  >
                    {crumb.title || "Untitled"}
                  </Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
        <TitleField
          page={page}
          editable={editable && online}
          autoFocus={p.isNew}
        />
        <View
          style={{
            paddingHorizontal: 16,
            flexDirection: "row",
            gap: 8,
            alignItems: "center",
          }}
        >
          <StatusPill phase={view.sync.phase} />
          {editable && !online && (
            <Text
              style={{
                fontSize: 13,
                color: colors.secondaryLabel,
                flexShrink: 1,
              }}
            >
              Title changes need a connection
            </Text>
          )}
        </View>
        {banner}
        {page.databaseId && (
          <RecordProperties
            recordId={page.id}
            databaseId={page.databaseId}
            editable={editable}
          />
        )}
      </ScrollView>
      <View style={{ flex: 1, marginTop: 8 }}>
        {session && (
          <DocEditor
            childPages={childPages}
            session={session}
            editable={editable}
            user={user}
            onReady={p.onEditorReady}
          />
        )}
        {!view.initialized && (
          <View
            style={{
              position: "absolute",
              inset: 0,
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              gap: 8,
              backgroundColor: colors.background,
            }}
          >
            {view.unavailable ? (
              <>
                <Text
                  accessibilityRole="header"
                  style={{
                    fontSize: 20,
                    fontWeight: "600",
                    color: colors.label,
                  }}
                >
                  Not available offline
                </Text>
                <Text
                  style={{
                    fontSize: 16,
                    color: colors.secondaryLabel,
                    textAlign: "center",
                  }}
                >
                  This page's content hasn't been saved on this device yet. It
                  will open when you're back online.
                </Text>
                <Button
                  kind="plain"
                  title="Try again"
                  onPress={() => session?.provider.reconnectNow()}
                />
              </>
            ) : (
              <ActivityIndicator accessibilityLabel="Loading page content" />
            )}
          </View>
        )}
      </View>
    </View>
  );
}

function FavoriteButton({
  page,
  online,
}: {
  page: PageDetail;
  online: boolean;
}) {
  const qc = useQueryClient();
  const toggle = async () => {
    const favorite = !page.favorite;
    qc.setQueryData<PageDetail>(keys.page(page.id), (x) =>
      x ? { ...x, favorite } : x,
    );
    try {
      await api.setFavorite(page.id, favorite);
      AccessibilityInfo.announceForAccessibility(
        favorite ? "Added to favorites" : "Removed from favorites",
      );
    } catch (err) {
      qc.setQueryData<PageDetail>(keys.page(page.id), (x) =>
        x ? { ...x, favorite: !favorite } : x,
      );
      Alert.alert("Couldn't update favorites", errorMessage(err));
    }
    void qc.invalidateQueries({ queryKey: keys.favorites(page.workspaceId) });
  };
  return (
    <HeaderButton
      label={page.favorite ? "Remove from favorites" : "Add to favorites"}
      glyph={page.favorite ? "★" : "☆"}
      disabled={!online}
      accessibilityHint={online ? undefined : "Needs a connection"}
      onPress={() => void toggle()}
    />
  );
}

/** Title saves with the page revision; on 409 the newer edit wins (theirs if made after ours). */
function TitleField({
  page,
  editable,
  autoFocus,
}: {
  page: PageDetail;
  editable: boolean;
  autoFocus: boolean;
}) {
  const qc = useQueryClient();
  const account = useAccount();
  const [value, setValue] = useState(page.title);
  const latest = useRef(page.title);
  const dirty = useRef(false);
  const editedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!dirty.current) setValue(page.title);
  }, [page.title]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const save = async (title: string) => {
    let revision =
      qc.getQueryData<PageDetail>(keys.page(page.id))?.revision ??
      page.revision;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await api.updatePage(page.id, {
          expectedRevision: revision,
          title,
        });
        qc.setQueryData<PageDetail>(keys.page(page.id), (x) =>
          x
            ? {
                ...x,
                title: r.page.title,
                revision: r.page.revision,
                updatedAt: r.page.updatedAt,
              }
            : x,
        );
        qc.setQueryData<RecordRow>(keys.record(page.id), (x) =>
          x ? { ...x, title: r.page.title, revision: r.page.revision } : x,
        );
        if (latest.current === title) dirty.current = false;
        invalidatePage(qc, page);
        if (page.databaseId)
          void qc.invalidateQueries({
            queryKey: keys.database(page.databaseId),
          });
        void openDoc(sqlOf(account), page.id, page.workspaceId, title).catch(
          () => {},
        );
        return;
      } catch (err) {
        const current = conflictCurrent<PageSummary>(err);
        if (!current) return Alert.alert("Title not saved", errorMessage(err));
        if (current.updatedAt > editedAt.current) {
          dirty.current = false;
          setValue(current.title);
          qc.setQueryData<PageDetail>(keys.page(page.id), (x) =>
            x ? { ...x, ...current } : x,
          );
          Alert.alert(
            "Title changed elsewhere",
            "Someone renamed this page after your edit; their title is kept.",
          );
          return;
        }
        revision = current.revision; // ours is newer: re-apply on the latest revision
      }
    }
  };

  const style = {
    fontSize: 32,
    fontWeight: "700" as const,
    color: colors.label,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  };
  if (!editable)
    return (
      <Text accessibilityRole="header" selectable style={style}>
        {page.icon ? `${page.icon} ` : ""}
        {page.title || "Untitled"}
      </Text>
    );
  return (
    <TextInput
      testID="page-title"
      accessibilityLabel="Page title"
      placeholder="Untitled"
      placeholderTextColor={colors.tertiaryLabel}
      value={value}
      autoFocus={autoFocus}
      maxLength={500}
      multiline
      submitBehavior="blurAndSubmit"
      returnKeyType="done"
      onChangeText={(t) => {
        const v = t.replace(/\n/g, " ");
        setValue(v);
        latest.current = v;
        dirty.current = true;
        editedAt.current = Date.now();
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void save(v), 600);
      }}
      onBlur={() => {
        if (!dirty.current) return;
        clearTimeout(timer.current);
        void save(latest.current);
      }}
      style={style}
    />
  );
}
