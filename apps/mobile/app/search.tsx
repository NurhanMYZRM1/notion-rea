import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Loading, Message, Row } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { openPage } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import { colors } from "@/lib/theme";

export default function Search() {
  const { current } = useWorkspace();
  const ws = current?.id ?? "";
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const results = useQuery({
    queryKey: ["search", ws, query],
    queryFn: () => api.search(ws, query).then((r) => r.results),
    enabled: !!ws && query.length > 0,
    staleTime: 10_000,
    retry: false,
  });

  return (
    <>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: "Search pages",
            autoFocus: true,
            hideWhenScrolling: false,
            autoCapitalize: "none",
            onChangeText: (e) => setText(e.nativeEvent.text),
            onCancelButtonPress: () => setText(""),
          },
        }}
      />
      {!query ? (
        <Message title="Search" body="Find pages by title or content." />
      ) : results.isPending ? (
        <Loading label="Searching" />
      ) : results.isError ? (
        <Message title="Couldn't search" body={errorMessage(results.error)} />
      ) : !results.data.length ? (
        <Message title="No results" body={`Nothing matches “${query}”.`} />
      ) : (
        <FlashList
          data={results.data}
          keyExtractor={(h) => h.pageId}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          style={{ backgroundColor: colors.grouped }}
          ItemSeparatorComponent={() => <View style={{ height: 1, marginLeft: 16, backgroundColor: colors.separator }} />}
          ListHeaderComponent={<Text style={{ padding: 16, paddingBottom: 6, color: colors.secondaryLabel, fontSize: 13 }}>{results.data.length} results</Text>}
          renderItem={({ item }) => (
            <Row
              title={item.title || "Untitled"}
              // FTS marks matches with [ ]; drop the markers for display.
              subtitle={item.snippet.replace(/[[\]]/g, "")}
              onPress={() => openPage({ id: item.pageId, title: item.title, isDatabase: false, workspaceId: ws })}
            />
          )}
        />
      )}
    </>
  );
}
