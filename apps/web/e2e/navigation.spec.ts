import { expect, test } from "@playwright/test";
import { apiPage, expectSynced, team, typeInDoc, closeContexts } from "./helpers";

test.afterEach(closeContexts);

test("Ctrl+K search finds text inside a page body and opens it with the keyboard", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const id = await apiPage(owner, ws, "Field notes");
  await apiPage(owner, ws, "Other page");
  const page = await owner.newPage();
  await page.goto(`/p/${id}`);
  await typeInDoc(page, "The zebracorn migrates north in spring.");
  await expectSynced(page);
  await page.goto(`/w/${ws}`);

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox", { name: "Search pages" });
  await expect(input).toBeFocused();
  // The search index is updated asynchronously after the document commits: retype until it shows up.
  const hit = page.getByRole("option", { name: /Field notes/ });
  const queries = ["zebracorn", "zebracor", "zebraco", "zebrac"];
  let i = 0;
  await expect
    .poll(
      async () => {
        await input.fill(queries[i++ % queries.length]!);
        return hit.isVisible().then(async (v) => v || (await page.waitForTimeout(1200), hit.isVisible()));
      },
      { timeout: 45_000, intervals: [300] },
    )
    .toBe(true);
  await expect(hit.locator("mark")).toHaveText(/zebrac/i);
  await input.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/p/${id}$`));
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);
});

test("the page tree supports arrow keys, Enter, and Alt+Arrow reordering", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const alpha = await apiPage(owner, ws, "Alpha");
  await apiPage(owner, ws, "Beta");
  await apiPage(owner, ws, "Alpha child", alpha);
  const page = await owner.newPage();
  await page.goto(`/w/${ws}`);
  const tree = page.getByRole("tree", { name: "Pages" });
  const item = (name: string) => tree.getByRole("treeitem", { name, exact: true });
  await expect(item("Beta")).toBeVisible();

  await item("Alpha").focus();
  await page.keyboard.press("ArrowDown");
  await expect(item("Beta")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(item("Alpha")).toBeFocused();
  await expect(item("Alpha")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(item("Alpha")).toHaveAttribute("aria-expanded", "true");
  await expect(item("Alpha child")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(item("Alpha child")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item("Alpha")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item("Alpha")).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("Alt+ArrowDown");
  await expect(tree.locator(':scope > [role="treeitem"]')).toHaveText([/Beta/, /Alpha/]);
  await expect(item("Alpha")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/p/${alpha}$`));
  await expect(page.getByLabel("Page title")).toHaveValue("Alpha");
});
