import { expect, test } from "@playwright/test";
import { apiPage, editor, expectNoAxeViolations, expectSynced, status, team, typeInDoc, closeContexts } from "./helpers";

test.afterEach(closeContexts);

test("create a page, use the slash menu and Markdown shortcuts, reload and stay synced", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const page = await owner.newPage();
  await page.goto(`/w/${ws}`);
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("button", { name: "New page" }).click();
  await expect(page).toHaveURL(/\/p\/pg_/);
  const title = page.getByLabel("Page title");
  await expect(title).toBeFocused();
  await expect(editor(page)).toBeVisible();
  await title.fill("Meeting notes");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toBeFocused();

  const slash = page.getByRole("listbox", { name: "Insert block" });
  await page.keyboard.type("/");
  await expect(slash).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(slash).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/head");
  await expect(slash.getByRole("option", { name: /Heading 1/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Agenda");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## Decisions");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- first point");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second point");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[ ] follow up");

  const doc = editor(page);
  await expect(doc.locator("h1")).toHaveText("Agenda");
  await expect(doc.locator("h2")).toHaveText("Decisions");
  await expect(doc.locator("ul:not([data-type]) > li")).toHaveText(["first point", "second point"]);
  await expect(doc.locator('ul[data-type="taskList"] li p')).toHaveText("follow up");
  await expectSynced(page);
  await expect(page.getByRole("navigation", { name: "Sidebar" }).getByRole("treeitem", { name: "Meeting notes" })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Page title")).toHaveValue("Meeting notes");
  await expect(doc.locator("h1")).toHaveText("Agenda");
  await expect(doc.locator("h2")).toHaveText("Decisions");
  await expect(doc.locator('ul[data-type="taskList"] li p')).toHaveText("follow up");
  await expectSynced(page);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Meeting notes");
  await expectNoAxeViolations(page, "page");
});

test("status never claims Synced before the server acknowledges", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const id = await apiPage(owner, ws, "Ack check");
  const page = await owner.newPage();
  // Hold every ACK (message type 2) back for a moment by delaying the socket's incoming messages.
  await page.addInitScript(() => {
    const orig = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (this: WebSocket, type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) {
      if (type !== "message" || !this.url.includes("/sync/")) return orig.call(this, type, fn, opts);
      const delayed = (e: Event) => {
        const data = (e as MessageEvent).data as ArrayBuffer;
        const isAck = new Uint8Array(data)[0] === 2;
        const deliver = () => (typeof fn === "function" ? fn.call(this, e) : fn.handleEvent(e));
        if (isAck) setTimeout(deliver, 1500);
        else deliver();
      };
      return orig.call(this, type, delayed, opts);
    } as typeof WebSocket.prototype.addEventListener;
  });
  await page.goto(`/p/${id}`);
  await expectSynced(page);
  await typeInDoc(page, "pending ack");
  await expect(status(page)).toHaveText("Syncing…");
  await expectSynced(page);
});
