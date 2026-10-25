import type { Me } from "@workspace/core";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef } from "react";
import { authClient, isUnauthenticated } from "./api";
import { lastUserId, persistQueries, restoreQueries, setLastUserId, wipeAccount } from "./persist";
import { useMe } from "./queries";
import { navigate, useLocation } from "./router";
import { Shell } from "./shell/Shell";
import { setDocAccount } from "./sync/cache-db";
import { Splash, Toaster } from "./ui";

const LoginPage = lazy(() => import("./pages/Auth").then((m) => ({ default: m.LoginPage })));
const InvitePage = lazy(() => import("./pages/Auth").then((m) => ({ default: m.InvitePage })));

export function App() {
  const { pathname } = useLocation();
  return (
    <>
      <Suspense fallback={<Splash />}>
        {pathname === "/login" ? <LoginPage /> : pathname === "/invite" ? <InvitePage /> : <Authed />}
      </Suspense>
      <Toaster />
    </>
  );
}

/** Keeps per-account caches (query metadata + documents) bound to whoever /api/me says is signed in. */
export function useAccountBinding(me: Me | undefined) {
  const qc = useQueryClient();
  const bound = useRef(lastUserId());
  useEffect(() => {
    const id = me?.user.id;
    if (!id || bound.current === id) return;
    bound.current = id;
    setLastUserId(id);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "workspaces" });
    setDocAccount(id);
    persistQueries(qc, id);
    void restoreQueries(qc, id);
  }, [me?.user.id, qc]);
}

function Authed() {
  const me = useMe();
  const loc = useLocation();
  useAccountBinding(me.data);
  const unauth = me.isError && isUnauthenticated(me.error);
  useEffect(() => {
    if (unauth) navigate(`/login?next=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`, { replace: true });
  }, [unauth, loc.pathname, loc.search, loc.hash]);

  if (unauth) return <Splash />;
  if (me.data) {
    if (!me.data.workspaces.length) return <NoWorkspace me={me.data} />;
    return <Shell me={me.data} />;
  }
  if (me.isError || (me.isPending && me.fetchStatus === "paused")) {
    return (
      <main className="center-card" id="main">
        <h1>{navigator.onLine ? "Couldn't reach Workspace" : "You're offline"}</h1>
        <p className="muted">{navigator.onLine ? "Something went wrong loading your account." : "This device has no saved copy of your workspace yet. Connect to the internet and try again."}</p>
        <button type="button" className="btn btn-primary" onClick={() => void me.refetch()}>
          Try again
        </button>
      </main>
    );
  }
  return <Splash />;
}

export async function signOutEverywhere(userId: string) {
  await authClient.signOut();
  await wipeAccount(userId);
  location.assign("/login");
}

function NoWorkspace({ me }: { me: Me }) {
  return (
    <main className="center-card" id="main">
      <h1>No workspace yet</h1>
      <p>
        You're signed in as <strong>{me.user.email}</strong>, but you aren't a member of any workspace.
      </p>
      <p className="muted">Workspaces are invitation-only. Ask a workspace owner to send you an invitation link, then open it while signed in with this account.</p>
      <button type="button" className="btn" onClick={() => void signOutEverywhere(me.user.id)}>
        Sign out
      </button>
    </main>
  );
}
