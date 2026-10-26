import { expect, test } from "@playwright/test";
import { apiPage, expectNoAxeViolations, team, uniqueEmail, closeContexts } from "./helpers";

test.afterEach(closeContexts);

test("settings: invitations, last-owner protection, agent help, theme, account deletion error", async ({ browser }) => {
  const { ws, owner, ownerEmail } = await team(browser, ["editor"]);
  const page = await owner.newPage();
  await page.goto(`/w/${ws}/settings`);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Members" }).getByRole("listitem")).toHaveCount(2);
  await expectNoAxeViolations(page, "settings (light)");

  // Invite: the returned link is shown with a copy button, and the invitation is listed as pending.
  const email = uniqueEmail("invitee");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("combobox", { name: /^Role(?! of)/ }).selectOption("viewer");
  await page.getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invitation link for" })).toContainText(/http:\/\/localhost:5173\/invite#\S+/);
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
  const invites = page.getByRole("list", { name: "Invitations" });
  await expect(invites.getByRole("listitem").filter({ hasText: email })).toContainText("Pending");
  await invites.getByRole("button", { name: `Revoke invitation for ${email}` }).click();
  await expect(invites.getByRole("listitem").filter({ hasText: email })).toContainText("Revoked");

  // The server refuses to demote the last owner; the error is shown.
  await page.getByLabel(/^Role of Olive Owner/).selectOption("editor");
  await expect(page.getByRole("alert")).toContainText("A workspace needs at least one owner");

  // Agent connection help uses this origin.
  await expect(page.locator(".help-box")).toContainText("claude mcp add --transport http --scope project notion-workspace http://localhost:5173/mcp");
  await expect(page.locator(".help-box")).toContainText("codex mcp login notion-workspace");
  await expect(page.getByText("No agents connected.")).toBeVisible();

  // Theme.
  await page.getByRole("radio", { name: "Dark" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoAxeViolations(page, "settings (dark)");
  await page.getByRole("radio", { name: "Match system" }).check();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);

  // Delete account needs the typed email, and the sole-owner refusal is surfaced.
  await page.getByRole("button", { name: "Delete account…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your account" });
  const confirm = dialog.getByRole("button", { name: "Delete account" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/Type your email/).fill(ownerEmail);
  await confirm.click();
  await expect(dialog.getByRole("alert")).toContainText("Transfer ownership before deleting your account");
});

test("trash: move to trash, restore, delete permanently", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const id = await apiPage(owner, ws, "Old draft");
  const page = await owner.newPage();
  await page.goto(`/p/${id}`);
  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await expect(page.getByRole("region", { name: "Page in trash" })).toContainText("This page is in the trash");
  await expect(page.locator(".ws-doc")).toHaveAttribute("contenteditable", "false");

  await page.getByRole("link", { name: "Trash" }).click();
  const list = page.getByRole("list", { name: "Pages in the trash" });
  await expect(list).toContainText("Old draft");
  await expectNoAxeViolations(page, "trash");
  await list.getByRole("button", { name: "Restore Old draft" }).click();
  await expect(page.getByText("The trash is empty.")).toBeVisible();
  await expect(page.getByRole("tree", { name: "Pages" }).getByRole("treeitem", { name: "Old draft" })).toBeVisible();

  await page.goto(`/p/${id}`);
  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await page.goto(`/w/${ws}/trash`);
  await page.getByRole("button", { name: "Delete Old draft permanently" }).click();
  const confirm = page.getByRole("dialog", { name: /Delete “Old draft” permanently/ });
  await confirm.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByText("The trash is empty.")).toBeVisible();
  await page.goto(`/p/${id}`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
