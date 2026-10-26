import { focusManager, QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider } from "expo-router";
import { addNetworkStateListener } from "expo-network";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, useColorScheme } from "react-native";
import { ActionSheetHost, PromptHost } from "@/components/ui";
import { useWorkspaceEvents } from "@/lib/events";
import { perfMark } from "@/lib/perf";
import { pendingInvite, SessionProvider, useSession, useWorkspace } from "@/lib/session";

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, gcTime: 24 * 60 * 60 * 1000 } },
});
focusManager.setEventListener((setFocused) => {
  const sub = AppState.addEventListener("change", (s) => setFocused(s === "active"));
  return () => sub.remove();
});

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <Navigation />
      </SessionProvider>
    </QueryClientProvider>
  );
}

function Navigation() {
  const { status } = useSession();
  const scheme = useColorScheme();
  useEffect(() => {
    if (status === "loading") return;
    void SplashScreen.hideAsync();
    perfMark(`shell-ready ${status} at=${Date.now()}`);
  }, [status]);
  if (status === "loading") return null;
  return (
    <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerBackButtonDisplayMode: "minimal" }}>
        <Stack.Protected guard={status === "signed-out"}>
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={status === "ready"}>
          <Stack.Screen name="index" options={{ title: "Workspace", headerLargeTitleEnabled: true }} />
          <Stack.Screen name="search" options={{ title: "Search" }} />
          <Stack.Screen name="page/[id]/index" options={{ title: "" }} />
          <Stack.Screen name="page/[id]/comments" options={{ title: "Comments", presentation: "modal" }} />
          <Stack.Screen name="database/[id]" options={{ title: "" }} />
          <Stack.Screen name="trash" options={{ title: "Trash", headerLargeTitleEnabled: true }} />
          <Stack.Screen name="settings" options={{ title: "Settings", headerLargeTitleEnabled: true }} />
        </Stack.Protected>
        <Stack.Screen name="invite/[token]" options={{ title: "Invitation" }} />
      </Stack>
      {status === "ready" && <SignedInEffects />}
      <ActionSheetHost />
      <PromptHost />
    </ThemeProvider>
  );
}

/** Background work for a signed-in account: workspace events, reconnect refetch, pending invites. */
function SignedInEffects() {
  const qc = useQueryClient();
  const { current } = useWorkspace();
  useWorkspaceEvents(current?.id ?? null);
  useEffect(() => {
    let reachable = true;
    // Refetch once per offline → online transition (the listener fires on every network change).
    const sub = addNetworkStateListener((s) => {
      const next = !!s.isConnected && s.isInternetReachable !== false;
      if (next && !reachable) void qc.invalidateQueries();
      reachable = next;
    });
    void pendingInvite.get().then((token) => token && router.push({ pathname: "/invite/[token]", params: { token } }));
    return () => sub.remove();
  }, [qc]);
  return null;
}
