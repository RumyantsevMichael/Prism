import { readOnlyNotice } from "./actions.js";
import { highlight, languageOf } from "./highlight.js";
import { badge, emptyState, escapeHtml, pageSub, plural, setPageSub } from "./util.js";

// The Code page of a workspace: one repository at a time, as a tree of the files on every pushed branch beside the file the person opens.
// The tree marks each file and folder where another branch differs from the branch chosen in Compare with, so no branch's files are hidden;
// Branch picks only which version the viewer shows. Turning a repository's code content on or off happens in the Repositories dialog.

const STATES = { on: ["On", "success"], off: ["Off", "neutral"], unreachable: ["Unreachable", "warning"] };
const SUB = "The files of this workspace's repositories on every pushed branch. Marks show where a branch differs from the one you compare with.";

const nameOf = (file) => file.slice(file.lastIndexOf("/") + 1);
const ancestorsOf = (file) => file.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));
const listed = (names) => names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
let ids = 0;

async function readJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const answer = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(answer?.message ?? "The review app could not read the repository's code."), { status: response.status });
  return answer;
}

// A toolbar choice whose options go in a menu: a button that names the choice, and the menu of radio items.
function menuPicker(label, value, options, marker, { icon = "", hint = () => "" } = {}) {
  const id = `code-menu-${++ids}`;
  return `<prism-button id="${id}" size="sm" variant="ghost" shrink tip="${escapeHtml(`${label}: ${value}`)}">${icon ? `<prism-icon name="${icon}" size="xs" aria-hidden="true"></prism-icon>` : ""}<span class="sr-only">${escapeHtml(label)}: </span><span>${escapeHtml(value)}</span><prism-icon name="chevron-down" size="xs" aria-hidden="true"></prism-icon></prism-button>
    <prism-menu for="${id}" heading="${escapeHtml(label)}" ${marker}>${options.map((option) => `<prism-menu-item type="radio" value="${escapeHtml(option)}"${option === value ? " checked" : ""}>${escapeHtml(option)}${hint(option) ? `<span slot="hint">${escapeHtml(hint(option))}</span>` : ""}</prism-menu-item>`).join("")}</prism-menu>`;
}

function toolbar(repositories, repository, place) {
  const word = (name) => STATES[repositories.find((item) => item.name === name)?.code.state]?.[0] ?? "";
  const picker = repositories.length > 1
    ? menuPicker("Repository", repository.name, repositories.map((item) => item.name), "data-code-repository-menu", { icon: "code", hint: (name) => word(name) === "On" ? "" : word(name) })
    : `<span class="code-repository-name"><prism-icon name="code" size="xs" aria-hidden="true"></prism-icon><strong>${escapeHtml(repository.name)}</strong></span>`;
  const branches = (repository.code.branches ?? []).map((branch) => branch.name);
  const choices = place.base && branches.length
    ? `<span class="library-toolbar-group"><span class="library-toolbar-label" aria-hidden="true">Branch</span>${menuPicker("Branch", place.branch, branches, "data-code-branch-menu")}</span>
      <span class="library-toolbar-group"><span class="library-toolbar-label" aria-hidden="true">Compare with</span>${menuPicker("Compare with", place.base, branches, "data-code-base-menu")}</span>`
    : "";
  return `<div class="library-toolbar code-toolbar" role="toolbar" aria-label="Code">
    <span class="library-toolbar-group">${picker}</span>${choices}
    <prism-button size="sm" variant="ghost" data-code-repositories><prism-icon name="settings" size="xs" aria-hidden="true"></prism-icon><span>Repositories</span></prism-button>
  </div>`;
}

// Each repository with its code state and its switch, in a dialog the toolbar opens.
function repositoriesDialog(repositories, writable) {
  const rows = repositories.map((repository) => {
    const [word, tone] = STATES[repository.code.state] ?? STATES.off;
    const on = repository.code.state !== "off";
    const count = repository.code.branches?.length ?? 0;
    const detail = repository.code.state === "on" ? `${count} ${count === 1 ? "branch" : "branches"}` : repository.code.state === "unreachable" ? repository.code.message ?? "" : "Code content keeps a clone of the repository's pushed branches on this machine.";
    return `<li class="code-repository-row" data-code-repository-row="${escapeHtml(repository.name)}">
      <span class="code-repository-about"><strong>${escapeHtml(repository.name)}</strong><span class="chip-row">${badge(word, tone)}<span class="muted">${escapeHtml(detail)}</span></span></span>
      <prism-button size="sm" variant="${on ? "ghost" : "primary"}" data-code-switch="${escapeHtml(repository.name)}" data-enabled="${on ? "false" : "true"}"${writable ? "" : " disabled"}>${on ? "Turn code content off" : "Turn code content on"}</prism-button>
    </li>`;
  }).join("");
  return `<prism-dialog heading="Repositories" data-code-dialog>${writable ? "" : readOnlyNotice()}<ul class="row-list code-repository-list">${rows}</ul></prism-dialog>`;
}

// What the compared branches change, by path, and the branches that change anything below each folder.
function marksOf(compared) {
  const files = new Map();
  const folders = new Map();
  for (const { branch, changes } of compared?.branches ?? []) {
    for (const { path, change } of changes) {
      if (!files.has(path)) files.set(path, []);
      files.get(path).push({ branch, change });
      for (const folder of ancestorsOf(path)) {
        if (!folders.has(folder)) folders.set(folder, new Set());
        folders.get(folder).add(branch);
      }
    }
  }
  return { files, folders };
}

const CHANGE_WORDS = { added: ["New on", "new on"], modified: ["Differs on", "differs on"], deleted: ["Removed on", "removed on"] };

// A file's mark and the sentence its tooltip says, such as "New on 1" and "New on feature-x", or null when every branch holds what the compared branch holds.
function fileMark(changes) {
  if (!changes?.length) return null;
  const kinds = [...new Set(changes.map((item) => item.change))];
  const word = kinds.length === 1 ? CHANGE_WORDS[kinds[0]][0] : "Differs on";
  const tip = kinds.map((kind, index) => `${CHANGE_WORDS[kind][index ? 1 : 0]} ${listed(changes.filter((item) => item.change === kind).map((item) => item.branch))}`).join("; ");
  return { text: `${word} ${changes.length}`, tip };
}

function folderMark(branches) {
  if (!branches?.size) return null;
  const names = [...branches].sort();
  return { text: names.length === 1 ? "1 branch" : `${names.length} branches`, tip: `Differs on ${listed(names)}` };
}

const flag = (mark) => mark ? `<span slot="end" class="prism-tree-flag is-warning">${escapeHtml(mark.text)}</span>` : "";
const PLACEHOLDER = '<prism-tree-item label="Loading…" value="" data-code-placeholder></prism-tree-item>';

function itemsHtml(entries, marks, place) {
  return entries.map((entry) => {
    const name = nameOf(entry.path);
    if (entry.type === "folder") {
      const mark = folderMark(marks.folders.get(entry.path));
      return `<prism-tree-item label="${escapeHtml(name)}" value="${escapeHtml(entry.path)}" data-code-folder="${escapeHtml(entry.path)}"${mark ? ` tip="${escapeHtml(`${name} · ${mark.tip}`)}"` : ""}><prism-icon slot="start" name="tree" size="sm" aria-hidden="true"></prism-icon>${flag(mark)}${PLACEHOLDER}</prism-tree-item>`;
    }
    const mark = fileMark(marks.files.get(entry.path));
    return `<prism-tree-item label="${escapeHtml(name)}" value="${escapeHtml(entry.path)}" data-code-file="${escapeHtml(entry.path)}"${entry.path === place.file ? " selected" : ""}${mark ? ` tip="${escapeHtml(`${name} · ${mark.tip}`)}"` : ""}><prism-icon slot="start" name="file" size="sm" aria-hidden="true"></prism-icon>${flag(mark)}</prism-tree-item>`;
  }).join("");
}

// The sentence that says how the shown version stands against the compared branch.
function standing(changes, shown, base) {
  if (shown === base) {
    const branches = changes.map((item) => item.branch);
    return branches.length ? `Other branches differ: ${listed(branches)}` : "Same on every branch";
  }
  const own = changes.find((item) => item.branch === shown)?.change;
  return own === "added" ? "New on this branch" : own === "modified" ? `Differs from ${base}` : `Same as ${base}`;
}

// One repository's tree and viewer, read from its clone and compared against the chosen branch.
async function browse(body, repository, place, listings) {
  const query = (route, params) => `./api/code/${route}?${new URLSearchParams({ repository: repository.name, ...params })}`;
  const list = async (folder) => {
    if (!listings.has(folder)) listings.set(folder, readJson(query("tree", { folder })).then((answer) => answer.entries).catch((error) => { listings.delete(folder); throw error; }));
    return listings.get(folder);
  };
  let compared = null;
  try { compared = await readJson(query("compare", place.base ? { base: place.base } : {})); }
  catch (error) {
    // A branch the clone no longer holds falls back to the remote's default branch.
    if (error.status === 404 && place.base) compared = await readJson(query("compare", {})).catch(() => null);
  }
  const branches = (repository.code.branches ?? []).map((branch) => branch.name);
  place.base = compared?.base ?? (branches.includes(place.base) ? place.base : branches[0]);
  if (!branches.includes(place.branch)) place.branch = place.base;
  let root;
  try { root = await list(""); }
  catch (error) {
    body.innerHTML = emptyState("No code to show", error.message);
    return { compared };
  }
  const marks = marksOf(compared);
  const holders = new Map();
  const remember = (entries) => { for (const entry of entries) if (entry.type === "file") holders.set(entry.path, entry.branches.map((item) => item.branch)); };
  remember(root);
  body.innerHTML = `<div class="code-browser">
    <div class="code-tree-pane" data-code-subject><prism-tree label="Files of ${escapeHtml(repository.name)}" data-code-tree>${itemsHtml(root, marks, place)}</prism-tree></div>
    <section class="code-view" aria-live="polite" data-code-view></section>
  </div>`;
  const tree = body.querySelector("[data-code-tree]");
  const view = body.querySelector("[data-code-view]");

  const fill = async (item) => {
    const placeholder = item.querySelector(":scope > .prism-tree-group > [data-code-placeholder]");
    if (!placeholder) return;
    let entries = [];
    try { entries = await list(item.dataset.codeFolder); }
    catch { placeholder.setAttribute("label", "Could not read this folder"); return; }
    remember(entries);
    item.insertAdjacentHTML("beforeend", itemsHtml(entries, marks, place));
    placeholder.remove();
  };

  const showFile = async (file) => {
    if (!file) {
      view.innerHTML = emptyState("Choose a file", "Pick a file in the tree to read it on the branch named in Branch.");
      return;
    }
    const holding = holders.get(file) ?? [];
    const changes = marks.files.get(file) ?? [];
    const differing = changes.filter((item) => item.change !== "deleted").map((item) => item.branch);
    const shown = holding.includes(place.branch) ? place.branch : holding.find((branch) => differing.includes(branch)) ?? holding[0] ?? place.branch;
    let read = null;
    let refused = null;
    try { read = await readJson(query("file", { branch: shown, path: file })); }
    catch (error) { refused = error; }
    if (place.file !== file) return;
    const content = read ? read.content.replace(/\r\n/g, "\n").replace(/\n$/, "") : "";
    const lines = read ? content.split("\n").length : 0;
    const removed = changes.find((item) => item.branch === place.branch && item.change === "deleted");
    const elsewhere = shown !== place.branch ? `<p class="code-view-note muted" data-code-elsewhere>${escapeHtml(`${removed ? `Removed on ${place.branch}` : `Not on ${place.branch}`}, so this is the version on ${shown}.`)}</p>` : "";
    const facts = [standing(changes, shown, place.base), read ? plural(lines, "line") : ""].filter(Boolean).join(" · ");
    const language = languageOf(file);
    view.innerHTML = `<p class="code-view-head"><code data-code-subject>${escapeHtml(file)}</code><prism-chip data-branch-label tip="The branch this version is read from">${escapeHtml(shown)}</prism-chip><span class="muted" data-code-standing>${escapeHtml(facts)}</span></p>
      ${elsewhere}
      ${read ? `<prism-code numbers${language ? ` language="${language}"` : ""}><pre><code>${highlight(content, language)}</code></pre></prism-code>` : emptyState("Not shown", refused?.status === 404 ? "The review app shows no secret, binary file, or file over 512 KiB." : refused?.message ?? "")}`;
  };

  tree.addEventListener("prism-toggle", (event) => {
    const item = event.target.closest?.("[data-code-folder]");
    if (!item || event.target !== item) return;
    const folder = item.dataset.codeFolder;
    place.expanded = event.detail.expanded ? [...new Set([...place.expanded, folder])] : place.expanded.filter((open) => open !== folder);
    if (event.detail.expanded) void fill(item);
  });
  tree.addEventListener("prism-select", (event) => {
    const item = [...tree.querySelectorAll("prism-tree-item")].find((candidate) => candidate.selected);
    if (item?.dataset.codeFolder !== undefined) {
      // A folder opens or closes, and the open file stays the tree's current item.
      item.expanded = !item.expanded;
      for (const other of tree.querySelectorAll("prism-tree-item")) other.selected = other.dataset.codeFile === place.file && place.file !== null;
      return;
    }
    if (item?.dataset.codeFile === undefined || event.detail.value === place.file) return;
    place.file = item.dataset.codeFile;
    void showFile(place.file);
  });

  // The folders open when the page was last drawn open again, parents first, so the open file shows in its place.
  const wanted = new Set([...place.expanded, ...(place.file ? ancestorsOf(place.file) : [])]);
  for (const folder of [...wanted].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))) {
    const item = tree.querySelector(`[data-code-folder="${CSS.escape(folder)}"]`);
    if (!item) continue;
    await fill(item);
    item.expanded = true;
  }
  await showFile(holders.has(place.file) ? place.file : (place.file = null));
  return { compared, showFile };
}

export async function render(container, entity, ctx) {
  const repositories = entity.data.repositories ?? [];
  const sub = pageSub(escapeHtml(SUB));
  if (!repositories.length) {
    const body = emptyState("No repositories", "The workspace's store registers no code repository yet.");
    container.innerHTML = setPageSub(container, sub, ctx) ? body : `${sub}${body}`;
    return;
  }
  const state = ctx.state.code ??= { repository: null, places: {} };
  const writable = ctx.canWrite?.() ?? false;
  const listings = new Map();

  const draw = async () => {
    const repository = repositories.find((item) => item.name === state.repository) ?? repositories.find((item) => item.code.state === "on") ?? repositories[0];
    state.repository = repository.name;
    const place = state.places[repository.name] ??= { branch: null, base: null, file: null, expanded: [] };
    const branches = (repository.code.branches ?? []).map((branch) => branch.name);
    if (!branches.includes(place.base)) place.base = null;
    const body = `<div data-code-toolbar></div><div class="code-body" data-code-body></div>${repositoriesDialog(repositories, writable)}`;
    container.innerHTML = setPageSub(container, sub, ctx) ? body : `${sub}${body}`;
    const bodyElement = container.querySelector("[data-code-body]");
    const drawToolbar = () => {
      container.querySelector("[data-code-toolbar]").innerHTML = toolbar(repositories, repository, place);
      bindToolbar();
    };
    let shown = null;
    const bindToolbar = () => {
      container.querySelector("[data-code-repository-menu]")?.addEventListener("prism-select", (event) => {
        if (event.detail.value === state.repository) return;
        state.repository = event.detail.value;
        void draw();
      });
      container.querySelector("[data-code-branch-menu]")?.addEventListener("prism-select", (event) => {
        if (event.detail.value === place.branch) return;
        place.branch = event.detail.value;
        drawToolbar();
        void shown?.showFile?.(place.file);
      });
      container.querySelector("[data-code-base-menu]")?.addEventListener("prism-select", (event) => {
        if (event.detail.value === place.base) return;
        place.base = event.detail.value;
        void draw();
      });
      container.querySelector("[data-code-repositories]").addEventListener("click", () => container.querySelector("[data-code-dialog]").show());
    };
    for (const control of container.querySelectorAll("[data-code-switch]")) {
      control.addEventListener("click", async () => {
        if (control.hasAttribute("disabled")) return;
        control.setAttribute("disabled", "");
        const answer = await ctx.setCode(control.dataset.codeSwitch, control.dataset.enabled === "true").catch((error) => ({ message: error.message }));
        if (answer?.message) ctx.showToast?.(answer.message);
        ctx.refresh?.();
      });
    }
    if (repository.code.state === "off") {
      drawToolbar();
      bodyElement.innerHTML = emptyState("Code content is off", "Turn this repository's code content on in Repositories to keep a clone of its pushed branches on this machine.");
      return;
    }
    if (repository.code.state === "unreachable" && !branches.length) {
      drawToolbar();
      bodyElement.innerHTML = emptyState("No code fetched yet", `${repository.code.message ?? "Prism could not fetch this repository."} Prism tries again at the next fetch.`);
      return;
    }
    if (!branches.length) {
      drawToolbar();
      bodyElement.innerHTML = emptyState("No branches yet", "The clone of this repository holds no pushed branch yet.");
      return;
    }
    // Listings belong to one repository, so another repository's page starts with none.
    if (listings.repository !== repository.name) {
      listings.clear();
      listings.repository = repository.name;
    }
    shown = await browse(bodyElement, repository, place, listings);
    drawToolbar();
  };
  await draw();
}
