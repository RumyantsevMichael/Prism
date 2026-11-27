import { highlight, languageOf } from "./highlight.js";
import { emptyState, escapeHtml } from "./util.js";

// The Code page: one files tree of every repository beside the open file, with the file's base and the versions that lines of work hold.
// The page shows the narrowing that the Code sidebar chose, a work item, a slice, or a line of work, or All work and branches,
// and a code file's address, code:<repository>:<path>, opens that file in the same page with the narrowing the place shows.
// It reads the Code routes itself and reads them again on each redraw that a push or a store sync asks for, keeping the open folders, the open file, and the chosen version.

const RETRY_MS = 1000;

// What the person chose, kept while the page stays loaded: the Files choice of each narrowing, the open folders,
// the folders that the person closed in Touched, the version chosen for each file, and, on a narrow window, which screen shows.
const memory = {
  files: new Map<string, string>(),
  expanded: new Set<string>(),
  closed: new Set<string>(),
  versions: new Map<string, string>(),
  screen: "tree"
};

// The page drawn last, which a redraw of clause 39 reads again.
let page: any = null;

// A press of the primary button inside the page holds its redraws until the press ends, and the page held back last then draws,
// since a redraw that replaces the pressed row between the press and the release would lose the person's click.
let pressed = false;
let held: any = null;
let releaseBound = false;

/** The scope of the Code routes that a narrowing address names: all, work:<initiative>, work:<initiative>/<slice>, or branch:<repository>/<branch>. */
function scopeOf(ref: string) {
  let match = /^code:work\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(ref ?? "");
  if (match) return `work:${match[1]}${match[2] ? `/${match[2]}` : ""}`;
  match = /^code:branch\/([^/:\s]+)\/(\S+)$/.exec(ref ?? "");
  if (match) return `branch:${match[1]}/${match[2]}`;
  return "all";
}

/** The repository and path that a code file's address names, or null. */
function fileOf(ref: string) {
  const match = /^code:([^:/]+):(.+)$/.exec(ref ?? "");
  return match ? { repository: match[1], path: match[2] } : null;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const repositoryOf = (path: string) => path.split("/")[0];
const inRepository = (path: string) => path.split("/").slice(1).join("/");
const ancestorsOf = (path: string) => path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));
const lineName = (line: any) => `${line.repository} · ${line.branch}`;

async function read(url: string) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

// The title that a narrowing names: a work item's or slice's title, or <repository> · <branch>, from the place's answer, or else the page's trail.
function narrowingTitle(ref: string, ctx: any) {
  const answer = ctx.codeAnswer?.();
  const scope = scopeOf(ref);
  const [kind, rest] = [scope.slice(0, scope.indexOf(":")), scope.slice(scope.indexOf(":") + 1)];
  if (answer && kind === "work") {
    const [initiative, slice] = rest.split("/");
    const work = answer.work?.find((item: any) => item.initiative === initiative);
    const title = slice ? work?.slices?.find((item: any) => item.slice === slice)?.title : work?.title;
    if (title) return title;
  }
  if (kind === "branch") {
    const at = rest.indexOf("/");
    return `${rest.slice(0, at)} · ${rest.slice(at + 1)}`;
  }
  return ctx.narrowingLabel?.(ref) ?? ref;
}

const icon = (name: string, slot = "start", size = "sm") => `<prism-icon slot="${slot}" name="${name}" size="${size}" aria-hidden="true"></prism-icon>`;
const flag = (text: string, tone = "is-warning") => `<span slot="end" class="prism-tree-flag ${tone}">${escapeHtml(text)}</span>`;
const avatar = (person: any, slot = "") => `<prism-avatar${slot ? ` slot="${slot}"` : ""} kind="${person.kind === "agent" ? "agent" : "person"}" name="${escapeHtml(person.name)}" size="sm"></prism-avatar>`;
const marks = (people: any[]) => people?.length ? `<span slot="end" class="code-place-people">${people.map((person) => avatar(person)).join("")}</span>` : "";
const quietNote = (text: string, retry: string, tone = "info") => `<prism-inline-note tone="${tone}" slot="end" class="code-place-note">${icon("info", "start", "xs")}<span>${escapeHtml(text)}</span><prism-button size="sm" variant="ghost" data-code-retry="${escapeHtml(retry)}">Try again</prism-button></prism-inline-note>`;

// A component badge: the layers icon and its name, and for a component that not every shown branch declares, how many do, named on hover and on keyboard focus.
function badges(components: any[]) {
  return (components ?? []).map((component) => {
    const some = component.declaredOn?.length ? component.declaredOn : null;
    const count = some ? `<span slot="meta">${some.length === 1 ? "1 branch" : `${some.length} branches`}</span>` : "";
    const tip = some ? ` tip="${escapeHtml(`Declared only on ${some.join(", ")}`)}"` : "";
    return `<prism-chip slot="end" tone="neutral"${tip}>${icon("layers", "start", "xs")}${escapeHtml(component.name)}${count ? ` ${count}` : ""}</prism-chip>`;
  }).join("");
}

const badgeTips = (components: any[]) => (components ?? []).filter((component) => component.declaredOn?.length).map((component) => `${component.name} is declared only on ${component.declaredOn.join(", ")}`);

export async function render(container: any, entity: any, ctx: any) {
  const repositories = entity.data?.repositories ?? [];
  if (!repositories.length) {
    page = null;
    container.innerHTML = emptyState("No repositories", "The workspace's store registers no code repository yet.");
    return;
  }
  const ref = ctx.path;
  const file = entity.data?.file ?? fileOf(ref);
  const narrowing = file ? ctx.codeNarrowing?.() ?? "code" : ref;
  if (file) {
    // A file opens with the folders that hold it open, so the tree shows it in its place.
    for (const folder of ancestorsOf(`${file.repository}/${file.path}`)) {
      memory.expanded.add(folder);
      memory.closed.delete(folder);
    }
  }
  memory.screen = file ? "file" : "tree";
  // The answers the page read last stay until a redraw reads them again, so opening a file or another narrowing draws the tree at once.
  if (page) clearTimeout(page.retry);
  const previous = page?.cache ?? new Map();
  page = { container, ctx, ref, narrowing, file, wanted: scopeOf(narrowing), scope: scopeOf(narrowing), unknown: false, cache: new Map(previous), generation: 0, syncing: null, retry: null };
  bind(page);
  await sync(page);
}

/** Reads the open Code page again, as after a push or a store sync, and draws it once the answers changed. */
export function refreshCodePage() {
  if (!page || !page.container.isConnected) return;
  if (page.syncing) {
    page.again = true;
    return;
  }
  void sync(page, { fresh: true });
}

const query = (current: any, params: Record<string, string>) => `${new URLSearchParams({ ...params })}&${current.ctx.codeQuery?.() ?? ""}`;
const filesUrl = (current: any, folder: string | null) => `./api/code/files?${query(current, folder ? { scope: current.scope, folder } : { scope: current.scope })}`;
const versionsUrl = (current: any) => `./api/code/versions?${query(current, { scope: current.scope, repository: current.file.repository, path: current.file.path })}`;
// A file of a repository whose code content is off is read as a record's link reads it, from a checkout on this machine.
const checkoutUrl = (current: any) => `./api/artifact?ref=${encodeURIComponent(`code:${current.file.repository}:${current.file.path}`)}`;
const diffUrl = (current: any, branch: string) => `./api/code/diff?${query(current, { repository: current.file.repository, path: current.file.path, branch })}`;

const filesChoice = (current: any) => current.unknown ? "all" : memory.files.get(current.scope) ?? (current.scope === "all" ? "all" : "touched");
const answered = (entry: any) => entry?.status === 200 ? entry.json : null;
const failed = (entry: any) => entry?.status === 503;
const preparing = (entry: any) => entry?.status === 202 || entry?.status === 0;

// The repositories whose files the tree can list: those whose top-level entry has no error and whose code content is not off.
const browsable = (entry: any) => entry.state !== "off" && !entry.error;

// The listings that the tree needs: each repository's root in Touched, to know whether it holds a touched file, and each open folder that a shown listing holds.
function neededListings(current: any, cache: Map<string, any>) {
  const top = answered(cache.get(filesUrl(current, null)));
  if (!top) return [];
  const touched = filesChoice(current) === "touched";
  const urls: string[] = [];
  const visit = (folder: string) => {
    const url = filesUrl(current, folder);
    urls.push(url);
    for (const entry of answered(cache.get(url))?.entries ?? []) {
      if (entry.type !== "folder") continue;
      if (touched && !entry.touched) continue;
      if (touched && !memory.closed.has(entry.path)) memory.expanded.add(entry.path);
      if (memory.expanded.has(entry.path)) visit(entry.path);
    }
  };
  for (const entry of top.entries) {
    if (!browsable(entry)) continue;
    if (touched && !memory.closed.has(entry.path)) memory.expanded.add(entry.path);
    if (touched || memory.expanded.has(entry.path)) visit(entry.path);
  }
  return urls;
}

// The version that the open file shows: the one the person chose, or else its first owned version, or else its first version, or else its base.
function openVersion(versions: any) {
  const key = `${versions.repository}:${versions.path}`;
  const chosen = memory.versions.get(key);
  const bases = versions.bases.map((base: any) => ({ ...base, id: `base:${base.branch}`, base: true }));
  const all = [...bases, ...versions.versions];
  return all.find((item) => item.id === chosen) ?? versions.versions.find((item: any) => item.owners?.length) ?? versions.versions[0] ?? bases[0] ?? null;
}

function neededUrls(current: any, cache: Map<string, any>) {
  const urls = [filesUrl(current, null), ...neededListings(current, cache)];
  if (current.file) {
    const url = versionsUrl(current);
    urls.push(url);
    const versions = answered(cache.get(url));
    const open = versions && openVersion(versions);
    if (open) urls.push(diffUrl(current, open.base ? open.branch : open.branches[0].branch));
    if (cache.get(url)?.json?.code === "code_off") urls.push(checkoutUrl(current));
  }
  return urls;
}

/**
 * Reads what the page needs and draws it: a first draw shows each answer as it comes, and a redraw reads every answer again and draws each
 * round's answers over the ones it read last, so the open file redraws once its own reads came rather than after every open folder's listing.
 * A read that Prism still prepares is asked again shortly, and a narrowing that the place does not list shows All.
 */
async function sync(current: any, { fresh = false } = {}) {
  const generation = ++current.generation;
  clearTimeout(current.retry);
  const cache = fresh ? new Map() : current.cache;
  // A redraw shows the answers it read last until each is read again, and keeps an answer that Prism now prepares again until the final draw.
  const shown = fresh ? new Map(current.cache) : cache;
  if (fresh) {
    current.scope = current.wanted;
    current.unknown = false;
  }
  let finish: any;
  current.syncing = new Promise((resolve) => { finish = resolve; });
  try {
    for (let round = 0; round < 32; round += 1) {
      const missing = neededUrls(current, cache).filter((url) => !cache.has(url));
      if (!missing.length) break;
      const results = await Promise.all(missing.map(read));
      if (generation !== current.generation) return;
      missing.forEach((url, index) => {
        cache.set(url, results[index]);
        if (shown !== cache && !(preparing(results[index]) && answered(shown.get(url)))) shown.set(url, results[index]);
      });
      const top = cache.get(filesUrl(current, null));
      if (top?.status === 404 && top.json?.code === "scope_unknown" && current.scope !== "all") {
        current.unknown = true;
        current.scope = "all";
      }
      current.cache = shown;
      draw(current);
    }
    if (generation !== current.generation) return;
    current.cache = cache;
    draw(current);
    if ([...cache.values()].some(preparing)) {
      current.retry = setTimeout(() => {
        for (const [url, entry] of current.cache) if (preparing(entry)) current.cache.delete(url);
        void sync(current);
      }, RETRY_MS);
    }
  } finally {
    if (generation === current.generation) current.syncing = null;
    finish();
    if (current.again && generation === current.generation) {
      current.again = false;
      void sync(current, { fresh: true });
    }
  }
}

function treeHtml(current: any) {
  const cache = current.cache;
  const top = cache.get(filesUrl(current, null));
  if (!top) return `<prism-spinner label="Reading the files of every repository"></prism-spinner>`;
  if (preparing(top)) return `<p class="code-place-none"><prism-spinner label="Prism is reading the branches"></prism-spinner> Prism is reading the branches of every repository.</p>`;
  if (!answered(top)) return emptyState("No files to show", top.json?.message ?? "The review app could not read the repositories' files.");
  const touched = filesChoice(current) === "touched";
  const openPath = current.file ? `${current.file.repository}/${current.file.path}` : null;
  const items = (folder: string, depth: number): string => {
    const listing = cache.get(filesUrl(current, folder));
    if (!listing || preparing(listing)) return `<prism-tree-item label="Loading…" value="" data-code-placeholder></prism-tree-item>`;
    const entries = answered(listing)?.entries ?? [];
    return entries.map((entry: any) => {
      if (touched && !(entry.type === "folder" ? entry.touched : entry.change)) return "";
      return entry.type === "folder" ? folderHtml(entry, depth) : fileHtml(entry);
    }).join("");
  };
  const folderHtml = (entry: any, depth: number) => {
    const listing = cache.get(filesUrl(current, entry.path));
    const open = memory.expanded.has(entry.path);
    const note = failed(listing) ? quietNote("Prism could not read this folder just now.", entry.path) : "";
    const tips = badgeTips(entry.components);
    const tip = tips.length ? ` tip="${escapeHtml([nameOf(entry.path), ...tips].join(" · "))}"` : "";
    const children = failed(listing) ? "" : open ? items(entry.path, depth + 1) : `<prism-tree-item label="Loading…" value="" data-code-placeholder></prism-tree-item>`;
    return `<prism-tree-item label="${escapeHtml(nameOf(entry.path))}" value="${escapeHtml(entry.path)}" data-code-folder="${escapeHtml(entry.path)}"${open ? " expanded" : ""}${tip}>${icon("tree")}${badges(entry.components)}${open ? "" : marks(entry.people)}${note}${children}</prism-tree-item>`;
  };
  const fileHtml = (entry: any) => {
    const change = entry.change;
    const word = !change ? "" : change.kind === "new" ? flag("New", "is-muted") : change.kind === "removed" ? flag("Removed", "is-muted") : flag(`${change.versions} versions`);
    const ref = `code:${repositoryOf(entry.path)}:${inRepository(entry.path)}`;
    const href = current.ctx.pageHref?.(ref);
    return `<prism-tree-item label="${escapeHtml(nameOf(entry.path))}" value="${escapeHtml(entry.path)}" data-code-file="${escapeHtml(ref)}"${href ? ` href="${escapeHtml(href)}"` : ""}${entry.path === openPath ? " selected" : ""}>${icon("file")}${word}${marks(entry.people)}</prism-tree-item>`;
  };
  const writable = current.ctx.canWrite?.() ?? false;
  const rows = answered(top).entries.map((entry: any) => {
    const name = entry.path;
    const root = browsable(entry) ? cache.get(filesUrl(current, name)) : null;
    const rootEntries = answered(root)?.entries ?? null;
    if (touched && !entry.error && !rootEntries?.some((child: any) => child.type === "folder" ? child.touched : child.change)) return "";
    const open = memory.expanded.has(name);
    let end = "";
    let children = "";
    let tip = "";
    if (entry.error) end = quietNote(`Prism could not read ${name} just now.`, `repository:${name}`);
    else if (entry.state === "off") end = `${flag("Off", "is-muted")}${writable ? `<prism-button slot="end" size="sm" variant="ghost" data-code-on="${escapeHtml(name)}">Turn code content on</prism-button>` : ""}`;
    else {
      end = badges(entry.components);
      if (entry.state === "unreachable") {
        end += flag("Unreachable");
        tip = [name, "Unreachable", entry.message].filter(Boolean).join(" · ");
      }
      if (failed(root)) end += quietNote(`Prism could not read ${name} just now.`, name);
      else if (preparing(root) && open) end += `<prism-spinner slot="end" label="Prism is reading the branches of ${escapeHtml(name)}"></prism-spinner>`;
      children = failed(root) || (root?.status === 404) ? "" : open ? items(name, 1) : `<prism-tree-item label="Loading…" value="" data-code-placeholder></prism-tree-item>`;
    }
    const tips = badgeTips(entry.components);
    if (!tip && tips.length) tip = [name, ...tips].join(" · ");
    return `<prism-tree-item label="${escapeHtml(name)}" value="${escapeHtml(name)}" data-code-repository="${escapeHtml(name)}"${children && open ? " expanded" : ""}${tip ? ` tip="${escapeHtml(tip)}"` : ""}>${icon("code")}${end}${children}</prism-tree-item>`;
  }).join("");
  const tree = `<prism-tree label="Files of every repository" data-code-tree>${rows}</prism-tree>`;
  return rows ? tree : `${tree}<p class="code-place-none">No file that this work changes is on a pushed branch yet. All files shows every file.</p>`;
}

// A version's chip label: its first owner's title, or else <repository> · <branch> of its first line of work.
const versionLabel = (version: any) => version.base ? version.branch : version.owners?.[0]?.title ?? lineName(version.branches[0]);
const ranges = (list: any[]) => list.map(([from, to]: any) => `${from}–${to}`).join(", ");

function chipsHtml(versions: any, open: any) {
  const chips = [
    ...versions.bases.map((base: any) => {
      const id = `base:${base.branch}`;
      return `<prism-chip interactive pressed="${open.id === id}" data-code-version="${escapeHtml(id)}" tip="${escapeHtml(`The file on ${base.branch}`)}">${icon("check", "start", "xs")}${escapeHtml(base.branch)} <span slot="meta">base</span></prism-chip>`;
    }),
    ...versions.versions.map((version: any) => {
      const who = version.owners?.length ? { kind: "agent", name: version.owners[0].agent } : version.people?.[0] ?? null;
      const delta = version.added === null || version.added === undefined ? "" : `<prism-line-delta added="${version.added}" removed="${version.removed}"></prism-line-delta>`;
      const meta = [delta, version.verified ? "verified" : ""].filter(Boolean).join(" · ");
      const tip = [...version.branches.map((line: any) => `${lineName(line)}, ${line.base ? `from ${line.base}` : "sharing no history with another branch"}`), who?.name, version.blob === null ? "Removes the file" : null].filter(Boolean).join(" · ");
      return `<prism-chip interactive pressed="${open.id === version.id}" data-code-version="${escapeHtml(version.id)}" tip="${escapeHtml(tip)}">${who ? avatar(who, "start") : ""}${escapeHtml(versionLabel(version))}${meta ? ` <span slot="meta">${meta}</span>` : ""}</prism-chip>`;
    })
  ];
  return `<div class="code-place-versions" role="group" aria-label="Versions of this file">${chips.join("")}</div>`;
}

function conflictsHtml(versions: any, open: any) {
  const entry = open.base ? null : versions.conflicts?.find((item: any) => item.version === open.id);
  if (!entry) return "";
  const byId = new Map(versions.versions.map((version: any) => [version.id, version]));
  const notes = entry.with.map((other: any) => `${versionLabel(byId.get(other.version))} also changes lines ${ranges(other.lines.other)}, so whichever merges second will conflict.`);
  if (entry.more > 0) notes.push(entry.more === 1 ? "1 more version also changes lines that this version changes." : `${entry.more} more versions also change lines that this version changes.`);
  if (entry.complete === false) notes.push("Too many versions change this file to check them all, so other versions may conflict too.");
  return notes.map((text: string) => `<prism-inline-note tone="warning">${icon("warning", "start", "xs")}<span>${escapeHtml(text)}</span></prism-inline-note>`).join("");
}

// A file that the review app does not show, such as a binary file or one over 512 KiB, says so and why; any other refusal says what it was.
const notShown = (entry: any, otherwise: string) => emptyState(entry.json?.code === "file_not_shown" ? "This file is not shown" : "Not shown", entry.json?.message ?? otherwise);

function contentHtml(current: any, open: any) {
  const entry = current.cache.get(diffUrl(current, open.base ? open.branch : open.branches[0].branch));
  if (!entry || preparing(entry)) return `<prism-spinner label="Reading the file"></prism-spinner>`;
  const diff = answered(entry);
  if (!diff) return notShown(entry, "The review app could not read this version of the file.");
  const language = languageOf(current.file.path);
  if (open.base) {
    const content = diff.rows.map((row: any) => row.text).join("\n");
    return `<prism-code numbers${language ? ` language="${language}"` : ""}><pre><code>${highlight(content, language)}</code></pre></prism-code>`;
  }
  const MARKS: Record<string, string> = { add: "+", del: "−", same: " " };
  const rows = diff.rows.map((row: any) => `<tr class="diff-${row.op}"><td class="diff-num">${row.before ?? ""}</td><td class="diff-num">${row.after ?? ""}</td><td class="diff-text"><span class="diff-mark" aria-hidden="true">${MARKS[row.op]}</span>${highlight(row.text, language)}</td></tr>`).join("");
  return `<div class="diff-scroll code-place-diff"><table class="line-diff"><tbody>${rows}</tbody></table></div>`;
}

// With code content off, Prism keeps no versions of the file, so the view shows the file as a checkout on this machine holds it, or says why it cannot.
function checkoutHtml(current: any) {
  const entry = current.cache.get(checkoutUrl(current));
  if (!entry || preparing(entry)) return `<prism-spinner label="Reading the file"></prism-spinner>`;
  const read = answered(entry);
  const off = `The code content of ${current.file.repository} is off, so Prism shows no versions of this file.`;
  if (typeof read?.content !== "string") return emptyState("No versions to show", `${off} Turn code content on from the repository's row to see them.`);
  const language = languageOf(current.file.path);
  const content = read.content.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return `<prism-inline-note tone="info">${icon("info", "start", "xs")}<span>${escapeHtml(`${off} This is the file as a checkout on this machine holds it.`)}</span></prism-inline-note><prism-code numbers${language ? ` language="${language}"` : ""}><pre><code>${highlight(content, language)}</code></pre></prism-code>`;
}

function fileHtml(current: any) {
  const back = `<div class="code-place-back"><prism-button size="sm" variant="ghost" data-code-back><prism-icon name="back" size="xs" aria-hidden="true"></prism-icon><span>Files</span></prism-button></div>`;
  if (!current.file) return `${back}${emptyState("Choose a file", "Pick a file in the tree to see its base and the versions that work in progress holds.")}`;
  const { repository, path } = current.file;
  const entry = current.cache.get(versionsUrl(current));
  const versions = answered(entry);
  const head = `<div class="code-place-head"><span class="code-place-path" data-code-subject><span class="code-place-repository">${escapeHtml(repository)}</span> / ${escapeHtml(path)}</span>${versions ? badges(versions.components).replaceAll(' slot="end"', "") : ""}</div>`;
  let body;
  if (!entry || preparing(entry)) body = `<prism-spinner label="Reading the file's versions"></prism-spinner>`;
  else if (failed(entry)) body = quietNote("Prism could not read this file just now.", "file").replace(' slot="end"', "");
  else if (entry.json?.code === "code_off") body = checkoutHtml(current);
  else if (!versions) body = notShown(entry, "The review app could not read this file.");
  else {
    const open = openVersion(versions);
    const diff = current.cache.get(diffUrl(current, open.base ? open.branch : open.branches[0].branch));
    body = failed(diff)
      ? quietNote("Prism could not read this file just now.", "file").replace(' slot="end"', "")
      : `${chipsHtml(versions, open)}${conflictsHtml(versions, open)}${contentHtml(current, open)}`;
  }
  return `${back}<div class="code-place-file-view">${head}${body}</div>`;
}

function draw(current: any) {
  const { container, ctx } = current;
  if (!container.isConnected && current !== page) return;
  if (pressed) {
    held = current;
    return;
  }
  const choice = filesChoice(current);
  const unknown = current.unknown ? `<prism-inline-note tone="info">${icon("info", "start", "xs")}<span>${escapeHtml(`${narrowingTitle(current.narrowing, ctx)} changes no code that the Code place shows.`)}</span></prism-inline-note>` : "";
  const scope = current.scope !== "all" ? `<p class="code-place-scope">Showing what <b>${escapeHtml(narrowingTitle(current.narrowing, ctx))}</b> changes</p>` : "";
  const html = `<div class="code-place" data-screen="${memory.screen}">
    <div class="code-place-files">
      <div class="code-place-tools">${unknown}${scope}<prism-segmented label="Files" value="${choice}" data-code-files><prism-option value="all">All files</prism-option><prism-option value="touched">Touched</prism-option></prism-segmented></div>
      ${treeHtml(current)}
    </div>
    <section class="code-place-file" aria-label="Open file" aria-live="polite">${fileHtml(current)}</section>
  </div>`;
  if (html === current.drawn && container.firstElementChild) return;
  current.drawn = html;
  const scroller = container.querySelector(".code-place-files");
  const top = scroller?.scrollTop ?? 0;
  container.innerHTML = html;
  const tree = container.querySelector(".code-place-files");
  if (tree) tree.scrollTop = top;
}

// The page's controls answer through the container, so a redraw keeps them working.
// A view that the app builds again out of sight stays the one showing until it is drawn, so a click on the view still showing acts on the page being built:
// what it opens or closes is kept in memory, which the new view draws, rather than lost with the view it was made on.
function bind(current: any) {
  const container = current.container;
  if (container.dataset.codeBound) return;
  container.dataset.codeBound = "true";
  let keep = false;
  container.addEventListener("pointerdown", (event: any) => {
    if (event.button === 0) pressed = true;
  }, { capture: true });
  if (!releaseBound) {
    releaseBound = true;
    // The click follows the release in the same task, so the held redraw comes after the click has been handled.
    const release = () => {
      if (!pressed) return;
      setTimeout(() => {
        pressed = false;
        const current = held;
        held = null;
        if (current) draw(current);
      }, 0);
    };
    for (const name of ["pointerup", "pointercancel", "blur"]) window.addEventListener(name, release, { capture: true });
  }
  container.addEventListener("click", (event: any) => {
    keep = Boolean(event.ctrlKey || event.metaKey);
    const target = event.target.closest?.("[data-code-retry], [data-code-on], [data-code-back], [data-code-version]");
    if (!target || !page) return;
    if (target.dataset.codeRetry !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      // Try again asks for the answer that failed again: a folder's listing, the open file's reads, or a repository's whole listing.
      const which = target.dataset.codeRetry;
      if (which === "file" || which.startsWith("repository:")) void sync(page, { fresh: true });
      else {
        page.cache.delete(filesUrl(page, which));
        void sync(page);
      }
    } else if (target.dataset.codeOn !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      if (target.hasAttribute("disabled")) return;
      target.setAttribute("disabled", "");
      void Promise.resolve(page.ctx.setCode?.(target.dataset.codeOn, true)).catch((error: any) => ({ message: error.message })).then((answer: any) => {
        if (answer?.message) page.ctx.showToast?.(answer.message);
        page.ctx.refresh?.();
        refreshCodePage();
      });
    } else if (target.dataset.codeBack !== undefined) {
      memory.screen = "tree";
      draw(page);
    } else if (target.dataset.codeVersion !== undefined) {
      // The chip shows pressed together with its version, once the version's difference came.
      memory.versions.set(`${page.file.repository}:${page.file.path}`, target.dataset.codeVersion);
      void sync(page);
    }
  }, { capture: true });
  container.addEventListener("change", (event: any) => {
    if (!event.target.matches?.("[data-code-files]") || !page) return;
    memory.files.set(page.scope, event.detail?.value ?? event.target.value);
    draw(page);
    void sync(page);
  });
  container.addEventListener("prism-toggle", (event: any) => {
    const item = event.target;
    const path = item.dataset?.codeFolder ?? item.dataset?.codeRepository;
    if (!path || !page) return;
    if (event.detail.expanded) {
      memory.expanded.add(path);
      memory.closed.delete(path);
    } else {
      memory.expanded.delete(path);
      memory.closed.add(path);
    }
    // The tree already shows the item open or closed, and the page draws it again once the folder's listing came.
    void sync(page);
  });
  container.addEventListener("prism-select", (event: any) => {
    if (!page) return;
    const item = [...container.querySelectorAll("prism-tree-item")].find((node: any) => node.selected && node.getAttribute("value") === event.detail?.value) as any;
    const opened = page.file ? `${page.file.repository}/${page.file.path}` : null;
    const reselect = () => { for (const node of container.querySelectorAll("prism-tree-item")) (node as any).selected = node.getAttribute("value") === opened && node.hasAttribute("data-code-file"); };
    if (!item || item.hasAttribute("data-code-placeholder")) {
      reselect();
      return;
    }
    if (item.dataset.codeFile === undefined) {
      // A folder or repository opens or closes, and the open file stays the tree's current item; a folder opens once its listing came, so it opens with its files.
      reselect();
      const path = item.dataset.codeFolder ?? item.dataset.codeRepository;
      if (!path || !item.querySelector(":scope > .prism-tree-group > prism-tree-item")) return;
      if (item.expanded) {
        memory.expanded.delete(path);
        memory.closed.add(path);
      } else {
        memory.expanded.add(path);
        memory.closed.delete(path);
      }
      void sync(page);
      return;
    }
    const ref = item.dataset.codeFile;
    memory.screen = "file";
    if (ref === page.ref && !keep) {
      draw(page);
      return;
    }
    if (!keep) reselect();
    page.ctx.openRef?.(ref, { keep });
    keep = false;
  });
}
