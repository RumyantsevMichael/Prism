import { highlightLines, languageOf } from "./highlight.js";
import { badge, card, chip, emptyState, escapeHtml } from "./util.js";

// The Code page of a workspace: each repository with its code content switch, and, while a repository's code content is on, its folders and files on every pushed branch.
// Each entry names the branches that hold it, and an open file shows one version per distinct content with the labels of the branches that hold it, so the page offers no branch choice.

const STATES = { on: ["On", "success"], off: ["Off", "neutral"], unreachable: ["Unreachable", "warning"] };

const branchLabels = (branches) => `<span class="chip-row code-branches">${branches.map((branch) => chip(escapeHtml(branch), { tip: branch, attributes: " data-branch-label" })).join("")}</span>`;
const parentOf = (folder) => folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
const nameOf = (file) => file.slice(file.lastIndexOf("/") + 1);

async function readJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? "The review app could not read the repository's code.");
  return response.json();
}

function header(repository, writable) {
  const [word, tone] = STATES[repository.code.state] ?? STATES.off;
  const on = repository.code.state !== "off";
  const detail = repository.code.state === "on" ? `${repository.code.branches?.length ?? 0} ${repository.code.branches?.length === 1 ? "branch" : "branches"}` : repository.code.state === "unreachable" ? repository.code.message ?? "" : "Turn code content on to keep a clone of this repository's pushed branches on this machine.";
  return `<div class="code-repository-head">
    <span class="chip-row">${badge(word, tone)}<span class="muted">${escapeHtml(detail)}</span></span>
    <prism-button size="sm" variant="${on ? "ghost" : "primary"}" data-code-switch="${escapeHtml(repository.name)}" data-enabled="${on ? "false" : "true"}"${writable ? "" : " disabled"}>${on ? "Turn code content off" : "Turn code content on"}</prism-button>
  </div>`;
}

// The folder listing and the open file of one repository, read from its clone.
async function browse(body, repository, place, rerender) {
  const query = (route, params) => `./api/code/${route}?${new URLSearchParams({ repository: repository.name, ...params })}`;
  let listing;
  try { listing = await readJson(query("tree", { folder: place.folder })); }
  catch (error) {
    // A repository whose first clone failed has no clone yet, which its Unreachable state already explains.
    body.innerHTML = repository.code.state === "unreachable" ? emptyState("No code fetched yet", "Prism has no clone of this repository's code yet and tries again at the next fetch.") : emptyState("No code to show", error.message);
    return;
  }
  const up = place.folder ? `<li><prism-button size="sm" variant="ghost" data-code-folder="${escapeHtml(parentOf(place.folder))}">..</prism-button></li>` : "";
  const rows = listing.entries.map((entry) => `<li><prism-button size="sm" variant="ghost" ${entry.type === "folder" ? "data-code-folder" : "data-code-file"}="${escapeHtml(entry.path)}">${escapeHtml(nameOf(entry.path))}${entry.type === "folder" ? "/" : ""}</prism-button>${branchLabels(entry.branches.map((item) => item.branch))}</li>`).join("");
  body.innerHTML = `<p class="artifact-path" data-code-subject>${escapeHtml(place.folder || repository.name)}</p>
    <ul class="row-list code-entries">${up}${rows || `<li class="muted">This folder holds nothing on any branch.</li>`}</ul>
    <div class="code-file"></div>`;
  for (const control of body.querySelectorAll("[data-code-folder]")) control.addEventListener("click", () => rerender({ folder: control.dataset.codeFolder, file: null }));
  for (const control of body.querySelectorAll("[data-code-file]")) control.addEventListener("click", () => rerender({ ...place, file: control.dataset.codeFile }));
  const opened = listing.entries.find((entry) => entry.type === "file" && entry.path === place.file);
  if (opened) await showFile(body.querySelector(".code-file"), repository, opened, query);
}

// One version per distinct content of a file, each read at the first branch that holds it and labelled with every branch that does.
async function showFile(target, repository, entry, query) {
  const versions = new Map();
  for (const { branch, blob } of entry.branches) {
    if (!versions.has(blob)) versions.set(blob, []);
    versions.get(blob).push(branch);
  }
  const parts = [];
  for (const branches of versions.values()) {
    let read = null;
    try { read = await readJson(query("file", { branch: branches[0], path: entry.path })); }
    catch { /* A binary or large file is not shown. */ }
    const body = read
      ? `<section class="document-sheet source-sheet" data-code-subject><ol class="source-lines">${highlightLines(read.content.replace(/\r\n/g, "\n").replace(/\n$/, ""), languageOf(entry.path)).map((line) => `<li><code>${line || " "}</code></li>`).join("")}</ol></section>`
      : emptyState("Not shown", "The review app shows no secret, binary file, or file over 512 KiB.");
    parts.push(card(nameOf(entry.path), `${branchLabels(branches)}${body}`, { eyebrow: repository.name, level: 3 }));
  }
  target.innerHTML = parts.join("");
}

export async function render(container, entity, ctx) {
  const repositories = entity.data.repositories ?? [];
  if (!repositories.length) {
    container.innerHTML = card("Code", emptyState("No repositories", "The workspace's store registers no code repository yet."), { eyebrow: "Library" });
    return;
  }
  ctx.state.code ??= {};
  container.innerHTML = repositories.map((repository) => card(repository.name, `${header(repository, ctx.canWrite?.() ?? false)}<div class="code-browser" data-code-repository="${escapeHtml(repository.name)}"></div>`, { eyebrow: "Code repository" })).join("");
  for (const control of container.querySelectorAll("[data-code-switch]")) {
    control.addEventListener("click", async () => {
      if (control.hasAttribute("disabled")) return;
      control.setAttribute("disabled", "");
      const answer = await ctx.setCode(control.dataset.codeSwitch, control.dataset.enabled === "true").catch((error) => ({ message: error.message }));
      if (answer?.message) ctx.showToast(answer.message);
      ctx.refresh?.();
    });
  }
  await Promise.all(repositories.filter((repository) => repository.code.state !== "off").map((repository) => {
    const body = container.querySelector(`[data-code-repository="${CSS.escape(repository.name)}"]`);
    const rerender = (place) => {
      ctx.state.code[repository.name] = place;
      return browse(body, repository, place, rerender);
    };
    return rerender(ctx.state.code[repository.name] ?? { folder: "", file: null });
  }));
}
