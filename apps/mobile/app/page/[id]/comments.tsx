import { can, type CommentInfo, newId } from "@workspace/core";
import { FlashList } from "@shopify/flash-list";
import { useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, confirm, HeaderButton, Loading, Message } from "@/components/ui";
import { api, errorMessage, useOnline } from "@/lib/api";
import { keys, kv } from "@/lib/queries";
import { OfflineError, useAccount, useCachedQuery, useWorkspace } from "@/lib/session";
import { colors, HIT } from "@/lib/theme";

export default function Comments() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const online = useOnline();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const account = useAccount();
  const { me } = useWorkspace();
  const page = useCachedQuery(keys.page(id), kv.page(id), () => api.page(id).then((r) => r.page));
  const comments = useCachedQuery(keys.comments(id), null, () => api.comments(id).then((r) => r.comments));
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const role = me.data?.workspaces.find((w) => w.id === page.data?.workspaceId)?.role;
  const canComment = can(role, "write") && page.data?.state === "active";

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      await api.addComment(id, body, newId("cm"));
      setDraft("");
      void qc.invalidateQueries({ queryKey: keys.comments(id) });
    } catch (err) {
      Alert.alert("Comment not posted", errorMessage(err));
    } finally {
      setSending(false);
    }
  };
  const remove = async (c: CommentInfo) => {
    if (!(await confirm("Delete comment?", "This can't be undone.", "Delete"))) return;
    try {
      await api.deleteComment(id, c.id);
      void qc.invalidateQueries({ queryKey: keys.comments(id) });
    } catch (err) {
      Alert.alert("Couldn't delete", errorMessage(err));
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, paddingTop: headerHeight, backgroundColor: colors.grouped }}>
      <Stack.Screen options={{ title: "Comments", headerRight: () => <HeaderButton label="Done" onPress={() => router.back()} /> }} />
      <View style={{ flex: 1 }}>
        {comments.isPending ? (
          <Loading label="Loading comments" />
        ) : comments.isError ? (
          <Message title={comments.error instanceof OfflineError ? "Not available offline" : "Couldn't load comments"} body={errorMessage(comments.error)} />
        ) : !comments.data.length ? (
          <Message title="No comments yet" body={canComment ? "Start the discussion below." : undefined} />
        ) : (
          <FlashList
            data={comments.data}
            keyExtractor={(c) => c.id}
            keyboardDismissMode="interactive"
            contentContainerStyle={{ paddingVertical: 8 }}
            renderItem={({ item }) => (
              <Pressable
                onLongPress={item.author.id === account.user.id ? () => void remove(item) : undefined}
                accessibilityLabel={`${item.author.name}, ${new Date(item.createdAt).toLocaleString()}: ${item.body}`}
                accessibilityHint={item.author.id === account.user.id ? "Long-press to delete" : undefined}
                accessibilityActions={item.author.id === account.user.id ? [{ name: "delete", label: "Delete comment" }] : undefined}
                onAccessibilityAction={() => void remove(item)}
                style={{ marginHorizontal: 16, marginVertical: 4, padding: 12, borderRadius: 12, borderCurve: "continuous", backgroundColor: colors.card, gap: 4 }}
              >
                <Text style={{ fontSize: 13, color: colors.secondaryLabel }}>
                  {item.author.name || "Someone"} · {new Date(item.createdAt).toLocaleString()}
                </Text>
                <Text selectable style={{ fontSize: 17, color: colors.label }}>
                  {item.body}
                </Text>
              </Pressable>
            )}
          />
        )}
      </View>
      {canComment && (
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 8, paddingBottom: Math.max(8, insets.bottom), borderTopWidth: 1, borderTopColor: colors.separator, backgroundColor: colors.background }}>
          <TextInput
            testID="comment-input"
            accessibilityLabel="Write a comment"
            placeholder={online ? "Add a comment" : "Comments need a connection"}
            placeholderTextColor={colors.tertiaryLabel}
            editable={online}
            multiline
            maxLength={5000}
            value={draft}
            onChangeText={setDraft}
            style={{ flex: 1, minHeight: HIT, maxHeight: 140, paddingHorizontal: 12, paddingTop: 11, paddingBottom: 11, borderRadius: 20, fontSize: 17, color: colors.label, backgroundColor: colors.fill }}
          />
          <Button title="Send" busy={sending} disabled={!online || !draft.trim()} onPress={() => void send()} />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
