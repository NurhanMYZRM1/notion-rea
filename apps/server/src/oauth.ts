import { AuthorizationError, CimdFetchError, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { AGENT_SCOPES } from "@workspace/core";
import type { Auth } from "./auth";
import { listWorkspaces } from "./domain/members";
import { createGrant, revokeGrant } from "./domain/grants";
import { log } from "./util";

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const SCOPE_TEXT: Record<string, string> = {
  "workspace:read": "Read pages, databases, comments and search",
  "workspace:write": "Create and edit pages, records and comments",
  "workspace:archive": "Move pages to the trash and restore them",
};

/** CSP source for a client's redirect URI; browsers apply form-action to the redirect after the consent POST. */
function redirectSource(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.origin === "null" ? url.protocol : url.origin;
}

function page(title: string, body: string, headers = new Headers(), status = 200, formTarget?: string): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTarget ? ` ${formTarget}` : ""}; frame-ancestors 'none'; base-uri 'none'`);
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f1f1f;--muted:#6b6b6b;--line:#e6e6e3;--accent:#2563eb;--warn:#fff7e6;--warnfg:#7a4b00}
@media (prefers-color-scheme:dark){:root{--bg:#191919;--fg:#ececec;--muted:#a0a0a0;--line:#333;--accent:#6ea0ff;--warn:#3a2c10;--warnfg:#ffd38a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:460px;margin:8vh auto;padding:0 16px}
h1{font-size:22px;margin:0 0 8px}p{margin:8px 0}.muted{color:var(--muted)}
fieldset{border:1px solid var(--line);border-radius:8px;margin:16px 0;padding:12px}
legend{padding:0 4px;font-weight:600}label{display:flex;gap:10px;align-items:flex-start;padding:6px 0;min-height:32px}
input{width:18px;height:18px;margin-top:3px}.warn{background:var(--warn);color:var(--warnfg);padding:10px 12px;border-radius:8px}
.row{display:flex;gap:12px;margin-top:20px}button{flex:1;min-height:44px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
code{font-size:14px}
</style><main>${body}</main></html>`,
    { status, headers },
  );
}

function consentHtml(details: ConsentDescription, handle: string, workspaces: { id: string; name: string; role: string }[]): string {
  const name = escape(details.clientName);
  const requested = details.scope.filter((s) => (AGENT_SCOPES as readonly string[]).includes(s));
  const preselect = new Set(requested.length ? requested : ["workspace:read"]);
  preselect.add("workspace:read");
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return `
<h1>Allow ${name} to use your workspace?</h1>
<p class="muted">${origin}</p>
<p>Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it (for example Claude Code or Codex).</p>' : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <fieldset><legend>Workspace</legend>
  ${workspaces
    .map(
      (w, i) =>
        `<label><input type="radio" name="workspace" value="${escape(w.id)}" ${i === 0 ? "checked" : ""} required><span>${escape(w.name)} <span class="muted">(${escape(w.role)})</span></span></label>`,
    )
    .join("")}
  </fieldset>
  <fieldset><legend>Permissions</legend>
  ${AGENT_SCOPES.map(
    (s) =>
      `<label><input type="checkbox" name="scope" value="${s}" ${preselect.has(s) ? "checked" : ""} ${s === "workspace:read" ? "disabled" : ""}><span>${escape(SCOPE_TEXT[s]!)}<br><code class="muted">${s}</code></span></label>`,
  ).join("")}
  <p class="muted">Your role still applies: a viewer's agent cannot edit. You can revoke this any time in Settings → Agent connections.</p>
  </fieldset>
  <div class="row"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Allow</button></div>
</form>`;
}

/** GET/POST /authorize — the consent page for MCP clients (Claude Code, Codex, …). */
export async function handleAuthorize(request: Request, env: OAuthEnv, auth: Auth): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      if (!session) {
        const next = new URL(request.url);
        return Response.redirect(`${env.PUBLIC_URL}/login?next=${encodeURIComponent(next.pathname + next.search)}`, 302);
      }
      const workspaces = await listWorkspaces(env, session.user.id);
      if (!workspaces.length) {
        return page("No workspace", `<h1>No workspace to connect</h1><p>You are signed in as ${escape(session.user.email)}, but you are not a member of any workspace yet. Ask an owner for an invitation.</p>`, new Headers(), 403);
      }
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return page(`Authorize ${details.clientName}`, consentHtml(details, consent.handle, workspaces), consent.headers, 200, redirectSource(authRequest.redirectUri));
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (!session) return page("Signed out", "<h1>You were signed out</h1><p>Start connecting again from your app.</p>", new Headers(), 401);
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const workspaceId = String(form.get("workspace") ?? "");
    const workspaces = await listWorkspaces(env, session.user.id);
    if (!workspaces.some((w) => w.id === workspaceId)) {
      return page("Not allowed", "<h1>That workspace is not available</h1>", new Headers(), 403);
    }
    const scope = ["workspace:read", ...form.getAll("scope").map(String).filter((s) => s !== "workspace:read" && (AGENT_SCOPES as readonly string[]).includes(s))];
    const approved = await oauth.approveConsent(request, handle, { scope });
    const client = await oauth.lookupClient(approved.request.clientId);
    const clientName = client?.clientName || approved.request.clientId;

    // One live grant per person + client + workspace: replacing it revokes the old one everywhere.
    const previous = await env.DB.prepare(
      "SELECT id FROM agent_grants WHERE user_id = ? AND client_id = ? AND workspace_id = ? AND revoked_at IS NULL",
    )
      .bind(session.user.id, approved.request.clientId, workspaceId)
      .all<{ id: string }>();
    for (const p of previous.results) await revokeGrant(env, session.user.id, p.id);

    const grantId = await createGrant(env, { userId: session.user.id, workspaceId, clientId: approved.request.clientId, clientName, scopes: scope });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: session.user.id,
      metadata: { grantId, workspaceId },
      scope,
      props: { userId: session.user.id, workspaceId, grantId, clientName },
      revokeExistingGrants: false,
    });
    approved.headers.set("Location", redirectTo);
    log("oauth_grant", { workspaceId, scopes: scope.join(" ") });
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
      return page("Authorization failed", `<h1>Authorization failed</h1><p>${escape(message ?? "Invalid request")}</p><p class="muted">Start connecting again from your app.</p>`, new Headers(), 400);
    }
    throw error;
  }
}
