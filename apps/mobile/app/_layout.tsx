import {
  focusManager,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  DarkTheme,
  DefaultTheme,
  router,
  Stack,
  ThemeProvider,
} from "expo-router";
import { addNetworkStateListener } from "expo-network";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState } from "react-native";
import { ActionSheetHost, PromptHost, ToastHost } from "@/components/ui";
import { useWorkspaceEvents } from "@/lib/events";
import { perfMark } from "@/lib/perf";
import {
  pendingInvite,
  SessionProvider,
  sqlOf,
  useSession,
  useWorkspace,
} from "@/lib/session";

import {
  colors,
  setThemePreference,
  useThemeScheme,
  type ThemePreference,
} from "@/lib/theme";
import { kvGet } from "@/lib/doc-store";

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 24 * 60 * 60 * 1000 },
  },
});
focusManager.setEventListener((setFocused) => {
  const sub = AppState.addEventListener("change", (s) =>
    setFocused(s === "active"),
  );
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
  const { status, account } = useSession();
  const scheme = useThemeScheme();
  useEffect(() => {
    if (account)
      void kvGet<ThemePreference>(sqlOf(account), "pref:theme").then((v) =>
        setThemePreference(v ?? "system"),
      );
    else setThemePreference("system");
  }, [account]);
  useEffect(() => {
    if (status === "loading") return;
    void SplashScreen.hideAsync();
    perfMark(`shell-ready ${status} at=${Date.now()}`);
  }, [status]);
  if (status === "loading") return null;
  return (
    <ThemeProvider
      value={{
        ...(scheme === "dark" ? DarkTheme : DefaultTheme),
        colors: {
          ...(scheme === "dark" ? DarkTheme.colors : DefaultTheme.colors),
          background: colors.background as string,
          card: colors.card as string,
          text: colors.label as string,
          border: colors.separator as string,
          primary: colors.label as string,
        },
      }}
    >
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerBackButtonDisplayMode: "minimal",
          headerShadowVisible: false,
          headerTintColor: colors.label,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Protected guard={status === "signed-out"}>
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={status === "ready"}>
          <Stack.Screen
            name="index"
            options={{ title: "Workspace", headerLargeTitleEnabled: false }}
          />
          <Stack.Screen name="graph" options={{ title: "Graph" }} />
          <Stack.Screen name="search" options={{ title: "Search" }} />
          <Stack.Screen name="page/[id]/index" options={{ title: "" }} />
          <Stack.Screen
            name="page/[id]/comments"
            options={{ title: "Comments", presentation: "modal" }}
          />
          <Stack.Screen name="database/[id]" options={{ title: "" }} />
          <Stack.Screen
            name="trash"
            options={{ title: "Trash", headerLargeTitleEnabled: true }}
          />
          <Stack.Screen
            name="settings"
            options={{ title: "Settings", headerLargeTitleEnabled: true }}
          />
        </Stack.Protected>
        <Stack.Screen name="invite/[token]" options={{ title: "Invitation" }} />
      </Stack>
      {status === "ready" && <SignedInEffects />}
      <ActionSheetHost />
      <PromptHost />
      <ToastHost />
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
    void pendingInvite
      .get()
      .then(
        (token) =>
          token &&
          router.push({ pathname: "/invite/[token]", params: { token } }),
      );
    return () => sub.remove();
  }, [qc]);
  return null;
}
