import { rm } from "node:fs/promises";
import test from "node:test";
import { git, isolateGit } from "./fixtures/workspace-view.mjs";
import { launch, skip } from "./fixtures/kit-browser.mjs";
import { open } from "./fixtures/places-browser.mjs";
import { codePlaceWorkspace, commitWork } from "./fixtures/code-place.mjs";
import { repainted } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/code-place.md §2, §18, §24.
// Contract: docs/plans/code-place/code-page-redraws/slice.md clauses 1 and 2, through the review page of a workspace in a browser.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const cleanups = [];
const suite = { after: (cleanup) => cleanups.push(cleanup) };
test.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
const TIMEOUT = { skip, timeout: 600000 };

const tree = (page) => page.getByRole("tree", { name: "Files of every repository" });
const treeRow = (page, name) => tree(page).getByRole("treeitem", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) }).first();
const expanded = (page, label) => page.waitForFunction((name) => [...document.querySelectorAll("prism-tree-item")].some((node) => node.getAttribute("label") === name && node.hasAttribute("expanded")), label, { timeout: 20000 });

async function codePage() {
  const built = await codePlaceWorkspace(suite);
  await built.ready("place");
  const browser = await launch(suite);
  const page = await open(browser, `${built.prism.viewer}/w/${built.id}`, "code");
  await tree(page).waitFor({ timeout: 20000 });
  return { ...built, page };
}

// The push gives api a new file at its root, so the page reads api's listing again and redraws the tree while the button is down.
async function pushNotes(owner, branch, file) {
  git(owner.root, "checkout", "-q", "-b", branch, "main");
  await commitWork(owner.root, { title: `add ${file}`, files: { [file]: "notes\n" } });
  git(owner.root, "push", "-q", "origin", branch);
  git(owner.root, "checkout", "-q", "main");
}

const listedWith = (page, file) => page.waitForResponse(async (response) => /\/api\/code\/files\?scope=all&folder=api&/.test(response.url()) && response.status() === 200 && (await response.text()).includes(`api/${file}`), { timeout: 30000 });

test("clauses 1 and 2: a folder pressed while a push redraws the tree opens on release, a cancelled press holds no redraw, and the held redraw then shows the push", TIMEOUT, async () => {
  const { owner, page } = await codePage();
  await treeRow(page, "api").locator(":scope > a").first().click();
  await expanded(page, "api");
  const box = await treeRow(page, "src").locator(":scope > a").first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const listed = listedWith(page, "NOTES.md");
  await pushNotes(owner, "team/notes", "NOTES.md");
  await listed;
  await repainted(page);
  await page.mouse.up();
  await expanded(page, "src");
  await treeRow(page, "retry").waitFor({ timeout: 20000 });
  await treeRow(page, "NOTES.md").waitFor({ timeout: 20000 });
  // A press that the window loses ends the hold as a release does, so the next push's redraw shows without a release.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const again = listedWith(page, "TODO.md");
  await pushNotes(owner, "team/todo", "TODO.md");
  await again;
  await treeRow(page, "TODO.md").waitFor({ timeout: 20000 });
  await page.mouse.up();
});
