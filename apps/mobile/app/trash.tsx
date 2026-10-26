import { ApiRequestError, can, type PageSummary } from "@workspace/core";
import { FlashList } from "@shopify/flash-list";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, View } from "react-native";
import {
  Banner,
  choose,
  confirm,
  Loading,
  Message,
  Row,
} from "@/components/ui";
import { api, errorMessage, useOnline } from "@/lib/api";
import { invalidatePage, keys } from "@/lib/queries";
import { OfflineError, useCachedQuery, useWorkspace } from "@/lib/session";
import { colors, useThemeScheme } from "@/lib/theme";

export default function Trash() {
  useThemeScheme();
  const { current } = useWorkspace();
  const ws = current?.id ?? "";
  const qc = useQueryClient();
  const online = useOnline();
  const trash = useCachedQuery(
    keys.trash(ws),
    null,
    () => api.trash(ws).then((r) => r.pages),
    { enabled: !!ws },
  );
  const canRestore = can(current?.role, "archive");
  const canDelete = can(current?.role, "delete_permanently");

  const act = async (p: PageSummary) => {
    const title = p.title || "Untitled";
    const action = await choose(title, [
      ...(canRestore ? [{ label: "Restore", value: "restore" as const }] : []),
      ...(canDelete
        ? [
            {
              label: "Delete permanently",
              value: "delete" as const,
              destructive: true,
            },
          ]
        : []),
    ]);
    if (!action) return;
    try {
      if (action === "restore") await api.restorePage(p.id);
      else {
        if (
          !(await confirm(
            `Delete “${title}” permanently?`,
            "It and everything inside it are deleted for everyone. This can't be undone.",
            "Delete permanently",
          ))
        )
          return;
        await api.deletePage(p.id);
      }
      invalidatePage(qc, p);
    } catch (err) {
      const root =
        err instanceof ApiRequestError
          ? (err.details as { archiveRoot?: string } | undefined)?.archiveRoot
          : undefined;
      Alert.alert(
        action === "restore" ? "Couldn't restore" : "Couldn't delete",
        root
          ? "This page was trashed with its parent. Restore the parent instead."
          : errorMessage(err),
      );
    }
  };

  if (trash.isPending) return <Loading label="Loading trash" />;
  if (trash.isError)
    return (
      <Message
        title={
          trash.error instanceof OfflineError
            ? "Not available offline"
            : "Couldn't load trash"
        }
        body={errorMessage(trash.error)}
      />
    );
  return (
    <FlashList
      data={trash.data}
      keyExtractor={(p) => p.id}
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.grouped }}
      ListHeaderComponent={
        !online ? (
          <Banner
            tone="warning"
            message="Restoring and deleting need a connection."
          />
        ) : (
          <View style={{ height: 12 }} />
        )
      }
      ListEmptyComponent={
        <Message
          title="Trash is empty"
          body="Pages you move to the trash appear here."
        />
      }
      ItemSeparatorComponent={() => (
        <View
          style={{
            height: 1,
            marginLeft: 16,
            backgroundColor: colors.separator,
          }}
        />
      )}
      renderItem={({ item }) => (
        <Row
          title={item.title || "Untitled"}
          subtitle={`Deleted ${new Date(item.updatedAt).toLocaleDateString()}`}
          disabled={!online || (!canRestore && !canDelete)}
          accessibilityHint={
            canDelete
              ? "Restore or delete permanently"
              : canRestore
                ? "Restore"
                : undefined
          }
          onPress={() => void act(item)}
        />
      )}
    />
  );
}
