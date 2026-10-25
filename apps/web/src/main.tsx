import { ApiRequestError } from "@workspace/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { lastUserId, persistQueries, restoreQueries } from "./persist";
import { setDocAccount } from "./sync/cache-db";
import { applyTheme, storedTheme } from "./theme";
import "./styles.css";

applyTheme(storedTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 24 * 60 * 60 * 1000, // persisted metadata must outlive navigation to be usable offline
      staleTime: 15_000,
      refetchOnWindowFocus: false, // the workspace event channel invalidates instead
      retry: (n, err) => !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500) && n < 2,
    },
    mutations: { retry: false },
  },
});

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => {
      // Resources fetched before the worker took control (first visit) are cached explicitly.
      const urls = [location.origin + "/", ...performance.getEntriesByType("resource").map((e) => e.name)];
      reg.active?.postMessage({ type: "cache-urls", urls });
    })
    .catch((err) => console.warn("service worker registration failed", err));
}

async function boot() {
  const uid = lastUserId();
  if (uid) {
    setDocAccount(uid);
    persistQueries(queryClient, uid);
    await restoreQueries(queryClient, uid);
  }
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
  registerServiceWorker();
}

void boot();
