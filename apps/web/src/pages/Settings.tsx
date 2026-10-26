import { can, type InvitationInfo, type Me, type MemberInfo, ROLES, type Role } from "@workspace/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { api, errorMessage } from "../api";
import { signOutEverywhere } from "../App";
import { exportDrafts } from "../drafts";
import { wipeAccount } from "../persist";
import { qk, roleIn } from "../queries";
import { TopBar } from "../shell/Shell";
import { clearDocs, type DocMeta, hasPending, listDocs } from "../sync/cache-db";
import { setTheme, storedTheme, type ThemePref } from "../theme";
import { ConfirmDialog, Dialog, OnlineButton, relTime, Spinner, toast, useOnline } from "../ui";

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

export default function Settings({ ws, me }: { ws: string; me: Me }) {
  const current = me.workspaces.find((w) => w.id === ws);
  useEffect(() => {
    document.title = "Settings · Workspace";
  }, []);
  if (!current) return null;
  const owner = can(roleIn(me, ws), "manage_members");
  return (
    <>
      <TopBar>
        <span className="crumb-current">Settings</span>
      </TopBar>
      <div className="doc settings">
        <h1 className="home-title">Settings</h1>
        <WorkspaceSection ws={ws} name={current.name} owner={owner} />
        <MembersSection ws={ws} me={me} owner={owner} />
        {owner && <InvitationsSection ws={ws} />}
        <AgentsSection />
        <AppearanceSection />
        <OfflineSection />
        <AccountSection me={me} />
      </div>
    </>
  );
}

function WorkspaceSection({ ws, name, owner }: { ws: string; name: string; owner: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => setValue(name), [name]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || value.trim() === name) return;
    setBusy(true);
    try {
      await api.renameWorkspace(ws, value.trim());
      await qc.invalidateQueries({ queryKey: qk.me });
      toast("Workspace renamed");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="set-ws">
      <h2 id="set-ws">Workspace</h2>
      {owner ? (
        <form className="row" onSubmit={(e) => void save(e)}>
          <label className="field" htmlFor={id}>
            <span>Name</span>
            <input id={id} value={value} maxLength={100} required onChange={(e) => setValue(e.target.value)} />
          </label>
          <OnlineButton type="submit" className="btn" disabled={busy || !value.trim() || value.trim() === name}>
            Rename
          </OnlineButton>
        </form>
      ) : (
        <p>
          <strong>{name}</strong> <span className="muted small">(only owners can rename it)</span>
        </p>
      )}
    </section>
  );
}

function MembersSection({ ws, me, owner }: { ws: string; me: Me; owner: boolean }) {
  const qc = useQueryClient();
  const online = useOnline();
  const q = useQuery({ queryKey: qk.members(ws), queryFn: () => api.members(ws) });
  const [remove, setRemove] = useState<MemberInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changeRole = async (m: MemberInfo, role: Role) => {
    setError(null);
    try {
      await api.updateMember(ws, m.userId, role);
      toast(`${m.name || m.email} is now ${ROLE_LABEL[role].toLowerCase()}`);
      if (m.userId === me.user.id) void qc.invalidateQueries({ queryKey: qk.me });
    } catch (err) {
      setError(errorMessage(err));
    }
    void qc.invalidateQueries({ queryKey: qk.members(ws) });
  };
  const doRemove = async (m: MemberInfo) => {
    setRemove(null);
    setError(null);
    try {
      await api.removeMember(ws, m.userId);
      toast(`Removed ${m.name || m.email}`);
      if (m.userId === me.user.id) await qc.invalidateQueries({ queryKey: qk.me });
    } catch (err) {
      setError(errorMessage(err));
    }
    void qc.invalidateQueries({ queryKey: qk.members(ws) });
  };
  return (
    <section aria-labelledby="set-members">
      <h2 id="set-members">Members</h2>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {q.isPending && q.fetchStatus !== "paused" && <Spinner label="Loading members" />}
      {(q.isError || q.fetchStatus === "paused") && !q.data && <p className="muted">{online ? errorMessage(q.error) : "Members aren't available offline."}</p>}
      {q.data && (
        <ul className="list" aria-label="Members">
          {q.data.members.map((m) => (
            <li key={m.userId}>
              <div className="who">
                <strong>
                  {m.name || m.email}
                  {m.userId === me.user.id ? " (you)" : ""}
                </strong>
                <span className="muted small">{m.email}</span>
              </div>
              {owner ? (
                <>
                  <label className="sr-only" htmlFor={`role-${m.userId}`}>
                    Role of {m.name || m.email}
                  </label>
                  <select id={`role-${m.userId}`} className="select" value={m.role} disabled={!online} onChange={(e) => void changeRole(m, e.target.value as Role)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <OnlineButton className="btn btn-small btn-ghost" aria-label={`Remove ${m.name || m.email}`} onClick={() => setRemove(m)}>
                    Remove
                  </OnlineButton>
                </>
              ) : (
                <span className="status-tag">{ROLE_LABEL[m.role]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {remove && (
        <ConfirmDialog
          title={`Remove ${remove.name || remove.email}?`}
          message="They lose access immediately: open pages close, and their agent connections to this workspace are revoked."
          confirm="Remove member"
          danger
          onClose={() => setRemove(null)}
          onConfirm={() => void doRemove(remove)}
        />
      )}
    </section>
  );
}

function InvitationsSection({ ws }: { ws: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.invitations(ws), queryFn: () => api.invitations(ws) });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const emailId = useId();
  const roleId = useId();
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.invite(ws, email.trim(), role);
      setLink({ email: r.invitation.email, url: r.url });
      setEmail("");
      void qc.invalidateQueries({ queryKey: qk.invitations(ws) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (inv: InvitationInfo) => {
    try {
      await api.revokeInvitation(ws, inv.id);
      toast(`Invitation for ${inv.email} revoked`);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
    void qc.invalidateQueries({ queryKey: qk.invitations(ws) });
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      toast("Couldn't copy. Select the link and copy it manually.", "error");
    }
  };
  return (
    <section aria-labelledby="set-invites">
      <h2 id="set-invites">Invitations</h2>
      <p className="muted small">Invitations are single-use, expire after 7 days, and only work for the invited email address. Send the link yourself.</p>
      <form className="row" onSubmit={(e) => void invite(e)}>
        <label className="field" htmlFor={emailId}>
          <span>Email</span>
          <input id={emailId} type="email" required value={email} maxLength={320} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field" htmlFor={roleId} style={{ flex: "0 1 140px" }}>
          <span>Role</span>
          <select id={roleId} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <OnlineButton type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
          Create invitation
        </OnlineButton>
      </form>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {link && (
        <div className="copy-box" role="status">
          <span className="small">Invitation link for {link.email}:</span>
          <code>{link.url}</code>
          <button type="button" className="btn btn-small" onClick={() => void copy(link.url)}>
            Copy link
          </button>
        </div>
      )}
      {q.data && q.data.invitations.length > 0 && (
        <ul className="list" aria-label="Invitations">
          {q.data.invitations.map((inv) => (
            <li key={inv.id}>
              <div className="who">
                <strong>{inv.email}</strong>
                <span className="muted small">
                  {ROLE_LABEL[inv.role]} · sent {relTime(inv.createdAt)}
                </span>
              </div>
              <span className={`status-tag ${inv.status === "pending" ? "is-pending" : ""}`}>{inv.status[0]!.toUpperCase() + inv.status.slice(1)}</span>
              {inv.status === "pending" && (
                <OnlineButton className="btn btn-small btn-ghost" aria-label={`Revoke invitation for ${inv.email}`} onClick={() => void revoke(inv)}>
                  Revoke
                </OnlineButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentsSection() {
  const qc = useQueryClient();
  const online = useOnline();
  const q = useQuery({ queryKey: qk.grants, queryFn: api.agentGrants });
  const origin = location.origin;
  const revoke = async (id: string, name: string) => {
    try {
      await api.revokeAgentGrant(id);
      toast(`Disconnected ${name}`);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
    void qc.invalidateQueries({ queryKey: qk.grants });
  };
  return (
    <section aria-labelledby="set-agents">
      <h2 id="set-agents">Agent connections</h2>
      <p className="muted small">AI coding agents you've connected through MCP. Each connection acts as you, in one workspace, with the scopes you approved.</p>
      {q.isPending && q.fetchStatus !== "paused" && <Spinner label="Loading agent connections" />}
      {!q.data && (q.isError || q.fetchStatus === "paused") && <p className="muted">{online ? errorMessage(q.error) : "Not available offline."}</p>}
      {q.data && q.data.grants.length === 0 && <p>No agents connected.</p>}
      {q.data && q.data.grants.length > 0 && (
        <ul className="list" aria-label="Agent connections">
          {q.data.grants.map((g) => (
            <li key={g.id}>
              <div className="who">
                <strong>{g.clientName}</strong>
                <span className="muted small">
                  {g.workspaceName} · {g.scopes.map((s) => s.replace("workspace:", "")).join(", ")} · connected {relTime(g.createdAt)} · last used {relTime(g.lastUsedAt)}
                </span>
              </div>
              <OnlineButton className="btn btn-small" aria-label={`Revoke ${g.clientName}`} onClick={() => void revoke(g.id, g.clientName)}>
                Revoke
              </OnlineButton>
            </li>
          ))}
        </ul>
      )}
      <div className="help-box">
        <strong>Connect an agent</strong>
        <p className="small">Claude Code:</p>
        <pre>
          <code>{`claude mcp add --transport http --scope project workspace ${origin}/mcp\nclaude mcp login workspace`}</code>
        </pre>
        <p className="small">Codex:</p>
        <pre>
          <code>{`codex mcp add workspace --url ${origin}/mcp\ncodex mcp login workspace`}</code>
        </pre>
        <p className="small muted">Signing in opens this site in your browser to choose a workspace and approve access.</p>
      </div>
    </section>
  );
}

function AppearanceSection() {
  const [theme, set] = useState<ThemePref>(storedTheme);
  return (
    <section aria-labelledby="set-theme">
      <h2 id="set-theme">Appearance</h2>
      <fieldset className="choice">
        <legend className="sr-only">Theme</legend>
        {(["system", "light", "dark"] as const).map((t) => (
          <label key={t}>
            <input
              type="radio"
              name="theme"
              value={t}
              checked={theme === t}
              onChange={() => {
                setTheme(t);
                set(t);
              }}
            />
            {t === "system" ? "Match system" : t === "light" ? "Light" : "Dark"}
          </label>
        ))}
      </fieldset>
    </section>
  );
}

function OfflineSection() {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const refresh = () =>
    listDocs()
      .then(setDocs)
      .catch((err) => setError(errorMessage(err)));
  useEffect(() => void refresh(), []);
  const pending = docs?.filter(hasPending) ?? [];
  const bytes = docs?.reduce((n, d) => n + d.bytes, 0) ?? 0;
  const clear = async (includePending: boolean) => {
    setAsking(false);
    try {
      const n = await clearDocs(includePending);
      toast(`Removed ${n} document${n === 1 ? "" : "s"} from this device`);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
    void refresh();
  };
  return (
    <section aria-labelledby="set-offline">
      <h2 id="set-offline">Offline cache</h2>
      <p className="muted small">Recently opened pages are kept on this device (up to 20 pages / 50 MB) so they open and save without a connection.</p>
      {error && <p className="muted">The offline cache isn't available: {error}</p>}
      {docs && (
        <>
          <div className="stats">
            <div>
              <strong>{docs.length}</strong>
              <span className="muted small">{docs.length === 1 ? "page" : "pages"} saved</span>
            </div>
            <div>
              <strong>{bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`}</strong>
              <span className="muted small">used</span>
            </div>
            <div>
              <strong>{pending.length}</strong>
              <span className="muted small">with unsynced changes</span>
            </div>
          </div>
          {pending.length > 0 && (
            <ul className="list" aria-label="Pages with unsynced changes">
              {pending.map((d) => (
                <li key={d.key}>
                  <span className="who">{d.title || "Untitled"}</span>
                  <span className="muted small">opened {relTime(d.lastOpened)}</span>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn" disabled={!docs.length} onClick={() => (pending.length ? setAsking(true) : void clear(false))}>
            Clear offline cache
          </button>
        </>
      )}
      {asking && (
        <Dialog
          title="Some changes haven't synced"
          onClose={() => setAsking(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => void exportDrafts(pending).catch((err) => toast(errorMessage(err), "error"))}>
                Export drafts (Markdown)
              </button>
              <button type="button" className="btn" onClick={() => void clear(false)}>
                Clear synced pages only
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void clear(true)}>
                Clear everything
              </button>
            </>
          }
        >
          <p>
            {pending.length} page{pending.length === 1 ? " has" : "s have"} changes that exist only on this device. Clearing everything deletes them. Export them first if you want
            to keep a copy.
          </p>
        </Dialog>
      )}
    </section>
  );
}

function AccountSection({ me }: { me: Me }) {
  const [signOut, setSignOut] = useState<DocMeta[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmId = useId();

  const finishSignOut = async () => {
    setBusy(true);
    await signOutEverywhere(me.user.id);
  };
  const startSignOut = async () => {
    const pending = (await listDocs().catch(() => [] as DocMeta[])).filter(hasPending);
    if (pending.length) setSignOut(pending);
    else void finishSignOut();
  };
  const del = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount();
      await wipeAccount(me.user.id);
      location.assign("/login");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="set-account">
      <h2 id="set-account">Account</h2>
      <p>
        Signed in as <strong>{me.user.email}</strong>
      </p>
      <div className="row gap wrap">
        <button type="button" className="btn" disabled={busy} onClick={() => void startSignOut()}>
          Sign out
        </button>
        <OnlineButton className="btn btn-ghost" onClick={() => setDeleting(true)}>
          Delete account…
        </OnlineButton>
      </div>
      {signOut && (
        <Dialog
          title="Sign out with unsynced changes?"
          onClose={() => setSignOut(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => void exportDrafts(signOut).catch((err) => toast(errorMessage(err), "error"))}>
                Export drafts (Markdown)
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void finishSignOut()}>
                Sign out and delete them
              </button>
            </>
          }
        >
          <p>Signing out removes this account's data from this device. These pages have changes that never reached the server:</p>
          <ul>
            {signOut.map((d) => (
              <li key={d.key}>{d.title || "Untitled"}</li>
            ))}
          </ul>
        </Dialog>
      )}
      {deleting && (
        <Dialog
          title="Delete your account"
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDeleting(false)}>
                Cancel
              </button>
              <OnlineButton className="btn btn-danger" disabled={busy || typed.trim().toLowerCase() !== me.user.email.toLowerCase()} onClick={() => void del()}>
                Delete account
              </OnlineButton>
            </>
          }
        >
          <p>You'll leave every workspace and your agent connections are revoked. Pages you created stay with their workspaces. This can't be undone.</p>
          <label className="field" htmlFor={confirmId}>
            <span>Type your email ({me.user.email}) to confirm</span>
            <input id={confirmId} data-autofocus autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </section>
  );
}

