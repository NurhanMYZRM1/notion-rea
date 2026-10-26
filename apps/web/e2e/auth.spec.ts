import { expect, test } from "@playwright/test";
import { bootstrap, expectNoAxeViolations, invite, newUser, PASSWORD, team, uniqueEmail, closeContexts } from "./helpers";

test.afterEach(closeContexts);

test("test-login sign-up, no-workspace state, then invitation accept", async ({ page }) => {
  const email = uniqueEmail("signup");
  const { workspaceId, inviteUrl } = bootstrap(email, "Signup Team");

  // An off-site `next` is ignored after signing in.
  await page.goto("/login?next=" + encodeURIComponent("//evil.example/steal"));
  await expect(page.getByRole("heading", { name: "Sign in to Workspace" })).toBeVisible();
  await expectNoAxeViolations(page, "login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create test account" }).click();
  await expect(page.getByRole("heading", { name: "No workspace yet" })).toBeVisible();
  expect(new URL(page.url()).origin).toBe("http://localhost:5173");

  await page.goto(inviteUrl);
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Signup Team" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
});

test("signed-out invitation link goes through sign-in and comes back", async ({ page }) => {
  const email = uniqueEmail("next");
  const { workspaceId, inviteUrl } = bootstrap(email, "Next Team");
  await page.goto(inviteUrl);
  await expect(page).toHaveURL(/\/login\?next=%2Finvite%23/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create test account" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}$`));
});

test("an invitation opened by a different account explains the mismatch", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const url = await invite(owner, ws, uniqueEmail("intended"), "editor");
  const other = await newUser(browser, uniqueEmail("other"));
  const page = await other.newPage();
  await page.goto(url);
  await expect(page.getByRole("alert")).toContainText("This invitation is for a different account");
  await expect(page.getByRole("button", { name: "Sign out and use another account" })).toBeVisible();
  await expectNoAxeViolations(page, "invite error");
});
