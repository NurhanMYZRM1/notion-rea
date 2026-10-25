import { ApiRequestError } from "@workspace/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, authClient, errorMessage, isUnauthenticated, safeNext } from "../api";
import { wipeAccount } from "../persist";
import { qk } from "../queries";
import { Link, navigate, useLocation } from "../router";
import { Spinner, useOnline } from "../ui";

function finish(next: string) {
  // The OAuth consent page is served by the Worker, not the SPA: leave the app for it.
  if (next.startsWith("/authorize")) location.assign(next);
  else navigate(next, { replace: true });
}

export function LoginPage() {
  const { search } = useLocation();
  const next = safeNext(search.get("next"));
  const qc = useQueryClient();
  const online = useOnline();
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers, staleTime: Infinity });
  const me = useQuery({ queryKey: qk.me, queryFn: api.me, retry: false });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Sign in · Workspace";
  }, []);
  useEffect(() => {
    if (me.data) finish(next);
  }, [me.data, next]);

  const done = async () => {
    await qc.resetQueries({ queryKey: qk.me });
    finish(next);
  };

  const submit = async (mode: "in" | "up") => {
    setBusy(true);
    setError(null);
    const name = email.split("@")[0] || "Test user";
    const res = mode === "in" ? await authClient.signIn.email({ email, password }) : await authClient.signUp.email({ email, password, name });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Sign-in failed");
    else await done();
  };

  return (
    <main className="auth" id="main">
      <div className="auth-card">
        <div className="auth-logo" aria-hidden="true">
          W
        </div>
        <h1>Sign in to Workspace</h1>
        {!online && <p className="banner banner-warn">You're offline. Signing in needs a connection.</p>}
        {providers.isPending && <Spinner />}
        {providers.isError && <p className="banner banner-error">Couldn't load sign-in options. {errorMessage(providers.error)}</p>}
        {providers.data?.google && (
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => void authClient.signIn.social({ provider: "google", callbackURL: location.origin + next })}
          >
            Continue with Google
          </button>
        )}
        {providers.data && !providers.data.google && !providers.data.testLogin && <p className="muted">No sign-in method is configured on this server.</p>}
        {providers.data?.testLogin && (
          <form className="dev-login" onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              void submit("in");
            }} aria-labelledby="dev-login-title">
            <h2 id="dev-login-title">
              Developer sign-in <span className="tag">local/test only</span>
            </h2>
            <p className="muted small">Email and password sign-in exists for local development and automated tests. It is disabled in production.</p>
            <label className="field">
              <span>Email</span>
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" autoComplete="current-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <div className="row gap">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Sign in
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={(e) => {
                  const form = e.currentTarget.form!;
                  if (form.reportValidity()) void submit("up");
                }}
              >
                Create test account
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}

export function InvitePage() {
  const token = location.hash.slice(1);
  const qc = useQueryClient();
  const me = useQuery({ queryKey: qk.me, queryFn: api.me, retry: false });
  const [error, setError] = useState<ApiRequestError | Error | null>(null);
  const started = useRef(false);
  const unauth = me.isError && isUnauthenticated(me.error);
  const loginHref = `/login?next=${encodeURIComponent(`/invite#${token}`)}`;

  useEffect(() => {
    document.title = "Invitation · Workspace";
  }, []);
  useEffect(() => {
    if (unauth && token) navigate(loginHref, { replace: true });
  }, [unauth, token, loginHref]);
  useEffect(() => {
    if (!me.data || !token || started.current) return;
    started.current = true;
    api
      .acceptInvitation(token)
      .then(async ({ workspaceId }) => {
        await qc.invalidateQueries({ queryKey: qk.me });
        navigate(`/w/${workspaceId}`, { replace: true });
      })
      .catch((err: Error) => setError(err));
  }, [me.data, token, qc]);

  const switchAccount = async () => {
    const id = me.data?.user.id;
    await authClient.signOut();
    if (id) await wipeAccount(id);
    qc.clear();
    navigate(loginHref, { replace: true });
  };

  let body;
  if (!token) body = <p>This invitation link is incomplete. Open the full link you were sent.</p>;
  else if (error) {
    const code = error instanceof ApiRequestError ? error.code : "internal";
    body = (
      <>
        <p className="banner banner-error" role="alert">
          {code === "not_found" || code === "invalid_input"
            ? "This invitation link is invalid. Check that you copied the whole link, or ask for a new one."
            : code === "network"
              ? "You're offline. Accepting an invitation needs a connection."
              : error.message}
        </p>
        {code === "forbidden" && me.data && (
          <>
            <p>
              You're signed in as <strong>{me.data.user.email}</strong>.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => void switchAccount()}>
              Sign out and use another account
            </button>
          </>
        )}
        {code === "gone" && <p className="muted">Ask a workspace owner to send you a new invitation.</p>}
        <p>
          <Link to="/">Go to Workspace</Link>
        </p>
      </>
    );
  } else if (me.isError && !unauth) body = <p className="banner banner-error">{errorMessage(me.error)}</p>;
  else body = <Spinner label="Accepting invitation" />;

  return (
    <main className="auth" id="main">
      <div className="auth-card">
        <h1>Join a workspace</h1>
        {body}
      </div>
    </main>
  );
}
