import { expect, type Page, test } from "@playwright/test";
import { expectNoAxeViolations, team, closeContexts } from "./helpers";

const rowTitles = (page: Page) => page.locator("table.db-table tbody tr[aria-rowindex] td.col-title .cell-btn");

async function addRow(page: Page, title: string) {
  await page.getByRole("button", { name: "New row" }).click();
  const input = page.getByRole("textbox", { name: "Name" });
  await expect(input).toBeFocused();
  await input.fill(title);
  await input.press("Enter");
  await expect(page.getByRole("button", { name: `Name: ${title}` })).toBeVisible();
}

const row = (page: Page, title: string) => page.getByRole("row").filter({ has: page.getByRole("button", { name: `Name: ${title}` }) });

test.afterEach(closeContexts);

test("database: rows, cells, properties, filter, sort, board move, CSV import", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const page = await owner.newPage();
  await page.goto(`/w/${ws}`);
  await page.getByRole("button", { name: "More ways to add" }).click();
  await page.getByRole("menuitem", { name: "New database" }).click();
  await expect(page).toHaveURL(/\/p\/pg_/);
  await page.getByLabel("Page title").fill("Tasks");
  await expect(page.getByRole("tab", { name: /Table/ })).toHaveAttribute("aria-selected", "true");

  await addRow(page, "Write spec");
  await addRow(page, "Ship it");
  await addRow(page, "Celebrate");
  await expect(rowTitles(page)).toHaveText(["Write spec", "Ship it", "Celebrate"]);

  // Status cell (status property with colored options).
  await row(page, "Ship it").getByRole("button", { name: /^Status:/ }).click();
  await row(page, "Ship it").getByRole("combobox", { name: "Status" }).selectOption({ label: "In progress" });
  await expect(row(page, "Ship it").getByRole("button", { name: "Status: In progress" })).toBeVisible();

  // Add a number property and a checkbox property.
  await page.getByRole("button", { name: "Properties" }).click();
  const props = page.getByRole("dialog", { name: "Properties" });
  await props.getByPlaceholder("Property name").fill("Points");
  await props.getByLabel("New property type").selectOption("number");
  await props.getByRole("button", { name: "Add property" }).click();
  await expect(props.getByLabel("Name of property Points")).toBeVisible();
  await props.getByPlaceholder("Property name").fill("Reviewed");
  await props.getByLabel("New property type").selectOption("checkbox");
  await props.getByRole("button", { name: "Add property" }).click();
  await expect(props.getByLabel("Name of property Reviewed")).toBeVisible();
  await props.getByRole("button", { name: "Done", exact: true }).click();

  for (const [title, pts] of [["Write spec", "3"], ["Ship it", "8"], ["Celebrate", "1"]] as const) {
    await row(page, title).getByRole("button", { name: /^Points:/ }).click();
    const input = row(page, title).getByRole("spinbutton", { name: "Points" });
    await input.fill(pts);
    await input.press("Enter");
    await expect(row(page, title).getByRole("button", { name: `Points: ${pts}` })).toBeVisible();
  }
  await row(page, "Celebrate").getByRole("checkbox", { name: "Reviewed" }).check();
  await expect(row(page, "Celebrate").getByRole("checkbox", { name: "Reviewed" })).toBeChecked();

  // Filter: Status is In progress.
  await page.getByRole("button", { name: /^Filter/ }).click();
  const fd = page.getByRole("dialog", { name: /Filters for/ });
  await fd.getByRole("button", { name: "Add filter" }).click();
  await fd.getByLabel("Filter 1 property").selectOption({ label: "Status" });
  await fd.getByLabel("Filter 1 value").selectOption({ label: "In progress" });
  await fd.getByRole("button", { name: "Save filters" }).click();
  await expect(rowTitles(page)).toHaveText(["Ship it"]);
  await page.getByRole("button", { name: /^Filter \(1\)/ }).click();
  await page.getByRole("dialog", { name: /Filters for/ }).getByRole("button", { name: "Remove filter 1" }).click();
  await page.getByRole("dialog", { name: /Filters for/ }).getByRole("button", { name: "Save filters" }).click();
  await expect(rowTitles(page)).toHaveCount(3);

  // Sort: Points descending.
  await page.getByRole("button", { name: /^Sort/ }).click();
  const sd = page.getByRole("dialog", { name: /^Sort/ });
  await sd.getByRole("button", { name: "Add sort" }).click();
  await sd.getByLabel("Sort 1 property").selectOption({ label: "Points" });
  await sd.getByLabel("Sort 1 direction").selectOption("desc");
  await sd.getByRole("button", { name: "Save sorts" }).click();
  await expect(rowTitles(page)).toHaveText(["Ship it", "Write spec", "Celebrate"]);
  await expectNoAxeViolations(page, "database table");

  // Board: drag a card to another column, then move one with the keyboard menu.
  await page.getByRole("tab", { name: /Board/ }).click();
  const col = (name: string) => page.getByRole("region", { name: new RegExp(`^${name}`) });
  await expect(col("In progress").getByRole("link", { name: "Ship it" })).toBeVisible();
  await expect(col("No Status").getByRole("link", { name: "Celebrate" })).toBeVisible();
  await col("No Status").locator("li.card", { hasText: "Celebrate" }).dragTo(col("Done"));
  await expect(col("Done").getByRole("link", { name: "Celebrate" })).toBeVisible();
  await expect(col("No Status").getByRole("link", { name: "Celebrate" })).toHaveCount(0);

  const menuBtn = page.getByRole("button", { name: "Move “Write spec” to column" });
  await menuBtn.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Move to Not started" }).press("Enter");
  await expect(col("Not started").getByRole("link", { name: "Write spec" })).toBeVisible();
  await expectNoAxeViolations(page, "database board");

  // The record page shows editable properties above its document.
  await col("Done").getByRole("link", { name: "Celebrate" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Celebrate");
  const header = page.getByRole("definition").filter({ has: page.getByRole("button", { name: /^Points:/ }) });
  await expect(header.getByRole("button", { name: "Points: 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Status: Done" })).toBeVisible();
  await expect(page.locator(".ws-doc")).toBeVisible();

  // CSV import: one malformed row is reported, the rest imported.
  await page.getByRole("button", { name: "More ways to add" }).click();
  await page.getByRole("menuitem", { name: "Import CSV…" }).click();
  const imp = page.getByRole("dialog", { name: "Import CSV as a database" });
  await imp.getByLabel(/CSV file/).setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Age\nAda,36\nGrace,45,extra\nLinus,28\n") });
  await imp.getByRole("button", { name: "Import" }).click();
  await expect(imp).toContainText("2 rows imported, 1 rejected");
  await expect(imp.getByRole("table", { name: "Rejected rows" })).toContainText("expected 2 columns, found 3");
  await imp.getByRole("button", { name: "Open database" }).click();
  await expect(page.getByRole("button", { name: "Name: Ada" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Age: 36" })).toBeVisible();
});
