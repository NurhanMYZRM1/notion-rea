import { expect, test } from "@playwright/test";
import { apiPage, docText, editor, expectSynced, status, team, typeInDoc, closeContexts } from "./helpers";

test.afterEach(closeContexts);

test("two people converge and see each other's caret", async ({ browser }) => {
  const { ws, owner, members } = await team(browser, ["editor"]);
  const id = await apiPage(owner, ws, "Shared doc");
  const a = await owner.newPage();
  const b = await members[0]!.ctx.newPage();
  await a.goto(`/p/${id}`);
  await b.goto(`/p/${id}`);
  await expectSynced(a);
  await expectSynced(b);

  await typeInDoc(a, "Hello from Olive");
  await expect.poll(() => docText(b)).toBe("Hello from Olive");
  await typeInDoc(b, " and Eddie");
  await expect.poll(() => docText(a)).toBe("Hello from Olive and Eddie");
  await expect.poll(() => docText(b)).toBe("Hello from Olive and Eddie");

  await expect(a.locator(".collaboration-carets__label")).toHaveText("Eddie Editor");
  await expect(b.locator(".collaboration-carets__label")).toHaveText("Olive Owner");
  await expect(a.getByRole("img", { name: "Also here: Eddie Editor" })).toBeVisible();
  await expectSynced(a);
  await expectSynced(b);
});

test("offline edits are saved on the device, survive an offline reload, and sync on reconnect", async ({ browser }) => {
  const { ws, owner, members } = await team(browser, ["editor"]);
  const id = await apiPage(owner, ws, "Offline doc");
  const a = await owner.newPage();
  await a.goto(`/p/${id}`);
  await expectSynced(a);
  // Load once more under the service worker so the app shell and page metadata are cached.
  await a.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15_000 });
  await a.reload();
  await expectSynced(a);
  await typeInDoc(a, "Typed online.");
  await expectSynced(a);

  const b = await members[0]!.ctx.newPage();
  await b.goto(`/p/${id}`);
  await expect(editor(b)).toContainText("Typed online.");

  await owner.setOffline(true);
  await expect(status(a)).toHaveText("Offline");
  await typeInDoc(a, " Written offline.");
  await expect(status(a)).toHaveText("Saved on device · offline");
  await expect(editor(b)).not.toContainText("Written offline");

  await a.reload();
  await expect(editor(a)).toContainText("Typed online. Written offline.");
  await expect(status(a)).toHaveText("Saved on device · offline");
  await expect(a.getByRole("navigation", { name: "Sidebar" }).getByRole("treeitem", { name: "Offline doc" })).toBeVisible();

  await owner.setOffline(false);
  await expectSynced(a);
  await expect.poll(() => docText(b)).toBe("Typed online. Written offline.");
});
