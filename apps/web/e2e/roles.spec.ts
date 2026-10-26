import { expect, test } from "@playwright/test";
import { apiDatabase, apiPage, editor, expectSynced, team, typeInDoc, closeContexts } from "./helpers";

test.afterEach(closeContexts);

test("viewers get a read-only page and database with no mutating controls", async ({ browser }) => {
  const { ws, owner, members } = await team(browser, ["viewer"]);
  const id = await apiPage(owner, ws, "Handbook");
  const dbId = await apiDatabase(owner, ws, "Roadmap");
  const o = await owner.newPage();
  await o.goto(`/p/${id}`);
  await typeInDoc(o, "Read this first.");
  await expectSynced(o);
  await o.goto(`/p/${dbId}`);
  await o.getByRole("button", { name: "New", exact: true }).click();
  await o.getByRole("textbox", { name: "Name" }).fill("Launch");
  await o.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(o.getByRole("button", { name: "Name: Launch" })).toBeVisible();

  const v = await members[0]!.ctx.newPage();
  await v.goto(`/p/${id}`);
  await expect(v.getByRole("region", { name: "View only" })).toContainText("You can view this page but not edit it");
  await expect(editor(v)).toContainText("Read this first.");
  await expect(editor(v)).toHaveAttribute("contenteditable", "false");
  await expect(v.getByRole("heading", { level: 1, name: "Handbook" })).toBeVisible();
  await expect(v.getByLabel("Page title")).toHaveCount(0);
  await expect(v.getByRole("button", { name: /Add icon/ })).toHaveCount(0);
  await expect(v.getByRole("button", { name: "New page" })).toHaveCount(0);
  await expect(v.getByRole("button", { name: "More ways to add" })).toHaveCount(0);
  await v.getByRole("button", { name: "Page actions" }).click();
  await expect(v.getByRole("menuitem")).toHaveText(["Export Markdown"]);
  await v.keyboard.press("Escape");
  await v.getByRole("button", { name: "Comments" }).click();
  await expect(v.getByRole("complementary", { name: "Comments" })).toBeVisible();
  await expect(v.getByLabel("Add a comment")).toHaveCount(0);
  await expect(v.getByRole("treeitem", { name: "Handbook" }).locator('[draggable="true"]')).toHaveCount(0);

  await v.goto(`/p/${dbId}`);
  await expect(v.getByRole("link", { name: "Launch" })).toBeVisible();
  for (const name of ["New", "New row", "Properties", "Add a view"]) await expect(v.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(v.getByRole("button", { name: /^Filter/ })).toHaveCount(0);
  await expect(v.getByRole("button", { name: /^Status:/ })).toHaveCount(0);
  await v.getByRole("tab", { name: /Board/ }).click();
  await expect(v.locator('li.card[draggable="true"]')).toHaveCount(0);
  await expect(v.getByRole("button", { name: /to column/ })).toHaveCount(0);
});

test("losing access keeps unsynced edits as an exportable draft", async ({ browser }) => {
  const { ws, owner, members } = await team(browser, ["editor"]);
  const id = await apiPage(owner, ws, "Secret plan");
  const ed = members[0]!;
  const page = await ed.ctx.newPage();
  await page.goto(`/p/${id}`);
  await expectSynced(page);
  await typeInDoc(page, "my notes");
  await expectSynced(page);

  const me = await ed.ctx.request.get("/api/me");
  const userId = ((await me.json()) as { user: { id: string } }).user.id;
  const res = await owner.request.delete(`/api/w/${ws}/members/${userId}`);
  expect(res.ok()).toBeTruthy();

  await expect(page.getByRole("alert")).toContainText("You no longer have access to this page. Your unsynced changes are kept on this device as a draft.");
  await expect(status(page)).toHaveText("Couldn't sync");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export draft (Markdown)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("Secret plan (draft).md");
});

const status = (page: import("@playwright/test").Page) => page.locator(".sync-status");
