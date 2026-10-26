import { expect, test } from "@playwright/test";
import { apiDatabase, apiPage, closeContexts, editor, expectNoAxeViolations, expectSynced, team, typeInDoc } from "./helpers";

test.afterEach(closeContexts);

test("inline subpages create at the cursor, open, rename, trash with Undo, and appear in Graph", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const parent = await apiPage(owner, ws, "Project home");
  const page = await owner.newPage();
  await page.goto(`/p/${parent}`);
  await expectSynced(page);
  await typeInDoc(page, "Keep this text");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/page");
  await page.getByRole("listbox", { name:"Insert block" }).getByRole("option", { name:/Page/ }).click();
  await expect(page).not.toHaveURL(new RegExp(`/p/${parent}`));
  const child = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByLabel("Page title")).toBeFocused();
  await page.getByLabel("Page title").fill("Design notes");
  await page.getByLabel("Page title").press("Enter");
  await expectSynced(page);
  await typeInDoc(page, "/page");
  await page.getByRole("listbox", { name:"Insert block" }).getByRole("option", { name:/Page/ }).click();
  await expect(page).not.toHaveURL(new RegExp(`/p/${child}`));
  const grandchild = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByLabel("Page title").fill("Deep notes");
  await page.getByLabel("Page title").press("Tab");
  await expect.poll(async () => (await (await owner.request.get(`/api/pages/${grandchild}`)).json()).page.title).toBe("Deep notes");
  await page.goto(`/p/${parent}`);
  await expectSynced(page);
  await expect(editor(page)).toContainText("Keep this text");
  await expect(editor(page).getByRole("button", { name:"Open Design notes" })).toBeVisible();
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  // End is immediately after the owning atom. Backspace archives its entire subtree.
  await page.keyboard.press("Backspace");
  await expect(page.getByRole("button", { name:"Undo", exact:true })).toBeVisible();
  await expect.poll(async () => (await (await owner.request.get(`/api/pages/${grandchild}`)).json()).page.state).toBe("archived");
  await page.getByRole("button", { name:"Undo", exact:true }).click();
  await expect(editor(page).getByRole("button", { name:"Open Design notes" })).toBeVisible();
  await page.goto(`/w/${ws}/graph?focus=${grandchild}`);
  await expect(page.locator(".graph-node").filter({ hasText:"Deep notes" })).toBeVisible();
  await expect(page.getByRole("complementary", { name:"Selected node" })).toContainText("Deep notes");
  await page.getByRole("button", { name:"Tree view", exact:true }).click();
  await expect(page.getByRole("tree", { name:"Workspace hierarchy" })).toContainText("Design notes");
  await expectNoAxeViolations(page, "hierarchy tree");
});

test("database records own subpages and their map branches stay collapsed until expanded", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const database = await apiDatabase(owner, ws, "Tasks");
  const response = await owner.request.post(`/api/databases/${database}/records`, { data:{ values:{} } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const record = (await response.json()).record.id;
  const page = await owner.newPage();
  await page.goto(`/p/${record}`);
  await expectSynced(page);
  await typeInDoc(page, "/page");
  await page.getByRole("listbox", { name:"Insert block" }).getByRole("option", { name:/Page/ }).click();
  await expect(page.getByLabel("Page title")).toBeFocused();
  await page.getByLabel("Page title").fill("Task details");
  await page.getByLabel("Page title").press("Tab");
  await page.goto(`/w/${ws}/graph`);
  await expect(page.locator(".graph-node").filter({ hasText:"Tasks" })).toBeVisible();
  await expect(page.locator(".graph-node").filter({ hasText:"Task details" })).toHaveCount(0);
  await page.getByRole("button", { name:"Expand Tasks", exact:true }).click();
  const nodes = await (await owner.request.get(`/api/w/${ws}/hierarchy?parentId=${database}`)).json();
  await expect(page.locator(`.graph-node[aria-label*="record"]`)).toHaveCount(nodes.nodes.length);
  const recordNode = page.locator('.graph-node[aria-label*="record"]').first();
  await recordNode.getByRole("button", { name:/^Select/ }).click();
  await expect(page.getByRole("complementary", { name:"Selected node" })).toBeVisible();
  await expect.poll(async () => {
    const canvas = await page.locator(".graph-viewport").boundingBox();
    const node = await recordNode.boundingBox();
    return !!canvas && !!node && node.x >= canvas.x && node.x + node.width <= canvas.x + canvas.width;
  }).toBe(true);
  await page.goto(`/p/${record}`);
  await expect(editor(page).getByRole("button", { name:"Open Task details" })).toBeVisible();
});

test("page menu stays inside the window and the sidebar resizes by keyboard in both themes", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const id = await apiPage(owner, ws, "Reference layout");
  const page = await owner.newPage();
  await page.setViewportSize({ width:1280, height:840 });
  await page.goto(`/p/${id}`);
  await expectSynced(page);
  const separator = page.getByRole("separator", { name:"Sidebar width" });
  await separator.focus(); await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "250");
  await separator.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "200");
  await page.getByRole("button", { name:"Page actions" }).click();
  const menu = await page.getByRole("menu", { name:"Page actions" }).boundingBox();
  expect(menu!.x).toBeGreaterThanOrEqual(0); expect(menu!.y).toBeGreaterThanOrEqual(0);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(1280); expect(menu!.y + menu!.height).toBeLessThanOrEqual(840);
  await page.keyboard.press("Escape");
  await expectNoAxeViolations(page, "reference light");
  await separator.focus(); for (let i = 0; i < 4; i++) await separator.press("ArrowRight");
  await page.getByLabel("Page title").click();
  await page.screenshot({ path:"test-results/reference-desktop-light.png" });
  await page.goto(`/w/${ws}/settings`);
  await page.getByRole("radio", { name:"Dark", exact:true }).check();
  await page.goto(`/p/${id}`);
  await expectSynced(page);
  await expectNoAxeViolations(page, "reference dark");
  await page.screenshot({ path:"test-results/reference-desktop-dark.png" });
});

test("retry after a lost creation response and reload reuses one page and owning block", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const parent = await apiPage(owner, ws, "Retry parent");
  const page = await owner.newPage();
  await page.goto(`/p/${parent}`);
  await expectSynced(page);
  await typeInDoc(page, "Preserve this content");
  await expectSynced(page);
  let interrupted = false;
  await page.route(`**/api/pages/${parent}/subpages`, async (route) => {
    if (!interrupted) { interrupted = true; const committed = await route.fetch(); expect(committed.ok()).toBeTruthy(); await route.abort("failed"); }
    else await route.continue();
  });
  const create = async () => { await page.getByRole("button", { name:"Page actions" }).click(); await page.getByRole("menuitem", { name:"Add a sub-page", exact:true }).click(); };
  await create();
  await expect.poll(async () => (await (await owner.request.get(`/api/w/${ws}/hierarchy?parentId=${parent}`)).json()).nodes.length).toBe(1);
  await expect(page.getByRole("status")).toContainText(/network|connection|fetch|offline/i);
  await page.reload();
  await expectSynced(page);
  await create();
  await expect(page).not.toHaveURL(new RegExp(`/p/${parent}`));
  const children = (await (await owner.request.get(`/api/w/${ws}/hierarchy?parentId=${parent}`)).json()).nodes;
  expect(children).toHaveLength(1);
  await expect(page).toHaveURL(new RegExp(`/p/${children[0].id}`));
  const doc = (await (await owner.request.get(`/api/pages/${parent}/document`)).json()).doc;
  expect(doc.content.filter((n: { type:string }) => n.type === "childPage")).toHaveLength(1);
  await page.goto(`/p/${parent}`);
  await expect(editor(page)).toContainText("Preserve this content");
});

test("Graph Move to can relocate a subpage into a database record and updates both documents", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const parent = await apiPage(owner, ws, "Source folder");
  const child = await apiPage(owner, ws, "Movable page", parent);
  const db = await apiDatabase(owner, ws, "Target database");
  const record = (await (await owner.request.post(`/api/databases/${db}/records`, { data:{ values:{} } })).json()).record.id;
  const recordDetail = (await (await owner.request.get(`/api/pages/${record}`)).json()).page;
  await owner.request.patch(`/api/pages/${record}`, { data:{ expectedRevision:recordDetail.revision,title:"Record parent" } });
  const page = await owner.newPage();
  await page.goto(`/w/${ws}/graph?focus=${child}`);
  const inspector = page.getByRole("complementary", { name:"Selected node" });
  await expect(inspector).toContainText("Movable page");
  await inspector.getByRole("button", { name:"Move to…", exact:true }).click();
  const dialog = page.getByRole("dialog", { name:'Move “Movable page”' });
  const tree = dialog.getByRole("tree", { name:"Destination pages" });
  const database = tree.getByRole("treeitem", { name:"Target database", exact:true });
  await database.focus(); await database.press("ArrowRight");
  const target = tree.getByRole("treeitem", { name:"Record parent", exact:true });
  await target.focus(); await target.press("Enter");
  await dialog.getByRole("button", { name:'Move into “Record parent”', exact:true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await (await owner.request.get(`/api/pages/${child}`)).json()).page.parentId).toBe(record);
  await page.goto(`/p/${parent}`);
  await expectSynced(page);
  await expect(editor(page).getByRole("button", { name:"Open Movable page" })).toHaveCount(0);
  await page.goto(`/p/${record}`);
  await expectSynced(page);
  await expect(editor(page).getByRole("button", { name:"Open Movable page" })).toBeVisible();
});

test("remote ancestor rename and move refresh an open descendant breadcrumb", async ({ browser }) => {
  const { ws, owner, members } = await team(browser, ["editor"]);
  const parent = await apiPage(owner, ws, "Original parent");
  const child = await apiPage(owner, ws, "Child page", parent);
  const destination = await apiPage(owner, ws, "Destination");
  const page = await members[0]!.ctx.newPage();
  await page.goto(`/p/${child}`);
  await expectSynced(page);
  const revision = (await (await owner.request.get(`/api/pages/${parent}`)).json()).page.revision;
  const changed = await owner.request.patch(`/api/pages/${parent}`, { data:{ expectedRevision:revision,title:"Renamed parent" } });
  expect(changed.ok()).toBeTruthy();
  await expect(page.getByRole("navigation", { name:"Breadcrumb" })).toContainText("Renamed parent");
  const nextRevision = (await changed.json()).page.revision;
  const moved = await owner.request.post(`/api/pages/${parent}/move`, { data:{ expectedRevision:nextRevision,parentId:destination } });
  expect(moved.ok()).toBeTruthy();
  await expect(page.getByRole("navigation", { name:"Breadcrumb" })).toContainText("Destination");
});

test("Graph removes a focused subtree after remote Trash and restricts viewer actions", async ({ browser }) => {
  const { ws, owner, members } = await team(browser, ["viewer"]);
  const parent = await apiPage(owner, ws, "Temporary parent");
  const child = await apiPage(owner, ws, "Temporary child", parent);
  const page = await members[0]!.ctx.newPage();
  await page.goto(`/w/${ws}/graph?focus=${child}`);
  const selected = page.getByRole("complementary", { name:"Selected node" });
  await expect(selected).toContainText("Temporary child");
  await expect(selected.getByRole("button", { name:/New|Move/ })).toHaveCount(0);
  expect((await owner.request.post(`/api/pages/${parent}/archive`)).ok()).toBeTruthy();
  await expect(page.locator(".graph-node").filter({ hasText:"Temporary child" })).toHaveCount(0);
  await expect(page.locator(".graph-node").filter({ hasText:"Temporary parent" })).toHaveCount(0);
  await expect(selected).toHaveCount(0);
});

test("Fit contains a full 100-record metadata branch without loading document bodies", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const db = await apiDatabase(owner, ws, "Large database");
  const detail = (await (await owner.request.get(`/api/pages/${db}`)).json()).page;
  const page = await owner.newPage();
  const bodyRequests:string[] = [];
  page.on("request", (req) => { if (/\/api\/pages\/[^/]+\/document(?:\?|$)|\/sync\/pg_/.test(req.url())) bodyRequests.push(req.url()); });
  let recordLoads = 0;
  await page.route(`**/api/w/${ws}/hierarchy*`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("parentId") === db) { recordLoads++; await route.fulfill({ json:{ nodes:Array.from({ length:100 }, (_, i) => ({ ...detail,id:`pg_record${i}`,parentId:db,databaseId:db,isDatabase:false,kind:"record",hasChildren:false,position:String(i).padStart(4,"0"),title:`Record ${i}` })), nextCursor:"more",path:[] } }); }
    else await route.fulfill({ json:{ nodes:[{ ...detail,kind:"database",hasChildren:true }],nextCursor:null,path:[] } });
  });
  await page.goto(`/w/${ws}/graph`);
  await expect(page.locator(".graph-node")).toHaveCount(2);
  expect(recordLoads).toBe(0);
  await page.getByRole("button", { name:"Expand Large database",exact:true }).click();
  await expect(page.locator(".graph-node")).toHaveCount(102);
  expect(recordLoads).toBe(1);
  await page.getByRole("button", { name:"Fit",exact:true }).click();
  const bounds = await page.locator(".graph-viewport").boundingBox();
  const map = await page.locator(".graph-viewport > svg > g").boundingBox();
  expect(map!.x).toBeGreaterThanOrEqual(bounds!.x); expect(map!.y).toBeGreaterThanOrEqual(bounds!.y);
  expect(map!.x + map!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width); expect(map!.y + map!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
  expect(bodyRequests).toEqual([]);
  await expect(page.getByRole("button", { name:"Load more in branch",exact:true })).toBeVisible();
});

test("long workspace menus stay inside a short viewport", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const page = await owner.newPage();
  await page.setViewportSize({ width:1024,height:400 });
  await page.route("**/api/me", async (route) => { const response = await route.fetch(); const value = await response.json(); value.workspaces.push(...Array.from({ length:60 }, (_, i) => ({ ...value.workspaces[0],id:`ws_extra${i}`,name:`Workspace ${i}` }))); await route.fulfill({ json:value }); });
  await page.goto(`/w/${ws}`);
  await page.getByRole("button", { name:/Switch workspace/ }).click();
  const menu = await page.getByRole("menu").boundingBox();
  expect(menu!.y).toBeGreaterThanOrEqual(8); expect(menu!.y + menu!.height).toBeLessThanOrEqual(392);
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem").last()).toBeFocused();
});

test("attachments and Markdown export remain usable beside owning subpages", async ({ browser }) => {
  const { ws, owner } = await team(browser);
  const parent = await apiPage(owner, ws, "Files parent");
  await apiPage(owner, ws, "Linked child", parent);
  const page = await owner.newPage();
  await page.goto(`/p/${parent}`);
  await expectSynced(page);
  await typeInDoc(page, "/file");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("listbox", { name:"Insert block" }).getByRole("option", { name:/^File/ }).click();
  await (await chooser).setFiles({ name:"acceptance.txt", mimeType:"text/plain", buffer:Buffer.from("Attachment contents remain intact.") });
  const link = editor(page).getByRole("link", { name:/acceptance.txt/ });
  await expect(link).toBeVisible();
  await expectSynced(page);
  const href = await link.getAttribute("href");
  const uploaded = await owner.request.get(href!);
  expect(uploaded.ok()).toBeTruthy();
  expect(await uploaded.text()).toBe("Attachment contents remain intact.");
  await page.reload();
  await expect(editor(page).getByRole("link", { name:/acceptance.txt/ })).toBeVisible();
  await expect(editor(page).getByRole("button", { name:"Open Linked child" })).toBeVisible();
  const markdown = await (await owner.request.get(`/api/pages/${parent}/export.md?format=json`)).json();
  expect(markdown.markdown).toContain("[Linked child]");
  expect(markdown.markdown).toContain("acceptance.txt");
});
