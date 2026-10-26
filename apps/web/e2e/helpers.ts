import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BASE = "http://localhost:5173";
export const PASSWORD = "e2e-password-123";
const SERVER_DIR = fileURLToPath(new URL("../../server", import.meta.url));
type Role = "owner" | "editor" | "viewer";

let seq = 0;
export const uniqueEmail = (tag: string) => `e2e-${tag}-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;

/** The real bootstrap command: a new workspace plus a single-use owner invitation for `email`. */
export function bootstrap(email: string, name = "Team"): { workspaceId: string; inviteUrl: string } {
  const out = execFileSync("node", ["scripts/bootstrap.mjs", "--email", email, "--name", name, "--force"], { cwd: SERVER_DIR, encoding: "utf8" });
  const workspaceId = /Workspace (ws_[0-9A-Za-z]+) created/.exec(out)?.[1];
  const inviteUrl = /(http:\/\/\S+\/invite#\S+)/.exec(out)?.[1];
  if (!workspaceId || !inviteUrl) throw new Error(`unexpected bootstrap output: ${out}`);
  return { workspaceId, inviteUrl };
}

const open: BrowserContext[] = [];
/** Close every context the helpers opened (call from afterEach; the browser outlives each test). */
export async function closeContexts() {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => {})));
}

/** Test-login sign-up through the API (the UI flow has its own test); the context holds the session cookie. */
export async function newUser(browser: Browser, email: string, name?: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: BASE });
  open.push(ctx);
  const res = await ctx.request.post("/api/auth/sign-up/email", { data: { email, password: PASSWORD, name: name ?? email.split("@")[0] }, headers: { Origin: BASE } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ctx;
}

export async function acceptInvite(ctx: BrowserContext, url: string) {
  const res = await ctx.request.post("/api/invitations/accept", { data: { token: url.split("#")[1] } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

export async function invite(ctx: BrowserContext, ws: string, email: string, role: Role): Promise<string> {
  const res = await ctx.request.post(`/api/w/${ws}/invitations`, { data: { email, role } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { url: string }).url;
}

export interface Member {
  ctx: BrowserContext;
  email: string;
}

/** A fresh workspace owned by "Olive Owner", plus one member per requested role. */
export async function team(browser: Browser, roles: Exclude<Role, "owner">[] = []) {
  const ownerEmail = uniqueEmail("owner");
  const owner = await newUser(browser, ownerEmail, "Olive Owner");
  const { workspaceId, inviteUrl } = bootstrap(ownerEmail, `Team ${seq}`);
  await acceptInvite(owner, inviteUrl);
  const members: Member[] = [];
  for (const role of roles) {
    const email = uniqueEmail(role);
    const ctx = await newUser(browser, email, role === "editor" ? "Eddie Editor" : "Vera Viewer");
    await acceptInvite(ctx, await invite(owner, workspaceId, email, role));
    members.push({ ctx, email });
  }
  return { ws: workspaceId, owner, ownerEmail, members };
}

export async function apiPage(ctx: BrowserContext, ws: string, title: string, parentId: string | null = null): Promise<string> {
  const res = await ctx.request.post(`/api/w/${ws}/pages`, { data: { title, parentId } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { page: { id: string } }).page.id;
}

export async function apiDatabase(ctx: BrowserContext, ws: string, title: string): Promise<string> {
  const res = await ctx.request.post(`/api/w/${ws}/databases`, { data: { title } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { database: { id: string } }).database.id;
}

export const status = (page: Page) => page.locator(".sync-status");
export const editor = (page: Page) => page.locator(".ws-doc");

export async function expectSynced(page: Page) {
  await expect(status(page)).toHaveText("Synced", { timeout: 20_000 });
}

/** Document text without collaborators' caret labels. */
export const docText = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector(".ws-doc")?.cloneNode(true) as HTMLElement | undefined;
    el?.querySelectorAll(".collaboration-carets__caret").forEach((c) => c.remove());
    return el?.textContent ?? "";
  });

/** Type at the end of the document. */
export async function typeInDoc(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

export async function expectNoAxeViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const found = result.violations.map((v) => `${v.id} [${v.impact}] ${v.help}: ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(found, `axe violations on ${label}`).toEqual([]);
}
