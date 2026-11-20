// Generated from src/server/review/public/views/library.ts by scripts/native-build/compile.mjs.
import { preference, setPreference } from "../kit/preferences.js";
import { artifactChip, artifactLink, bindLinks, card, documentTitle, emptyState, escapeHtml, pageSub, plural, recordStatus, setPageSub, shortDate } from "./util.js";
const GROUPINGS = Object.freeze({
  requirements: [["scope", "Scope"], ["status", "Status"], ["area", "Area"], ["initiative", "Initiative"], ["none", "None"]],
  decisions: [["scope", "Scope"], ["area", "Area"], ["status", "Status"], ["initiative", "Initiative"], ["none", "None"]],
  diagrams: [["scope", "Scope"], ["owner", "Belongs to"], ["kind", "Kind"], ["none", "None"]],
  glossary: [["scope", "Scope"], ["none", "None"]]
});
const STATUS_ORDER = ["Approved", "Accepted", "Proposed", "Draft", "Superseded", "Withdrawn", "Deprecated"];
const NO_STATUS = "No status";
const statusWord = (entry) => String(entry.status ?? "").trim().split(/\s+/)[0] || NO_STATUS;
const statusRank = (word) => word === NO_STATUS ? Infinity : STATUS_ORDER.indexOf(word) === -1 ? STATUS_ORDER.length : STATUS_ORDER.indexOf(word);
function scopeChip(path, ctx, scope) {
  const label = scope ?? ctx.scopeLabel?.(path);
  return label && !ctx.groupedByScope ? `<prism-chip data-scope-label>${escapeHtml(label)}</prism-chip>` : "";
}
const scopeSource = (label) => label === "workspace" ? "every repository" : label.includes("/") ? `component of ${label.split("/")[0]}` : "repository";
const byScopeLabel = (left, right) => left === "workspace" ? -1 : right === "workspace" ? 1 : left.localeCompare(right);
const head = (columns) => `<div class="prism-lib-row is-head" aria-hidden="true">${columns.map((column) => `<span>${escapeHtml(column)}</span>`).join("")}</div>`;
const groupHead = (name, count, source = "") => `<div class="prism-lib-group"><h2 class="prism-lib-group-name">${name} <prism-badge tone="neutral">${count}</prism-badge></h2>${source ? `<span class="prism-lib-group-source">${escapeHtml(source)}</span>` : ""}</div>`;
const cell = (html, className = "") => `<span class="prism-lib-cell${className ? ` ${className}` : ""}">${html}</span>`;
const quiet = (text) => cell(escapeHtml(text), "muted");
function titleCell(path, ctx, title, icon, detail = "", scope = null) {
  return `<span class="prism-lib-title"><prism-icon class="prism-lib-kind" name="${icon}" size="sm" aria-hidden="true"></prism-icon><span class="prism-lib-title-text">${artifactLink(path, ctx, title)}${scopeChip(path, ctx, scope)}${detail ? `<span class="prism-lib-cell is-detail">${escapeHtml(detail)}</span>` : ""}</span></span>`;
}
function linkChip(ref, ctx, label, meta = "") {
  const chip = artifactChip(ref, ctx, label);
  return meta ? chip.replace(/<\/prism-chip>$/, `<span slot="meta">${escapeHtml(meta)}</span></prism-chip>`) : chip;
}
function dated(entry, decision) {
  if (!decision && entry.approved && shortDate(entry.approved)) return `Approved ${shortDate(entry.approved)}`;
  return entry.created && shortDate(entry.created) ? `${decision ? "" : "Created "}${shortDate(entry.created)}` : "";
}
const areaOf = (entry) => entry.topic ?? "General";
function assigned(entry, ctx) {
  const slices = /* @__PURE__ */ new Map();
  for (const use of entry.assignedTo ?? []) {
    const key = `${use.initiative}/${use.slug}`;
    if (!slices.has(key)) slices.set(key, { use, anchors: [] });
    if (use.anchor && !slices.get(key).anchors.includes(use.anchor)) slices.get(key).anchors.push(use.anchor);
  }
  if (!slices.size) return quiet("Not assigned yet");
  return cell([...slices].map(([key, { use, anchors }]) => linkChip(`slice:${key}`, ctx, use.title, anchors.length ? `req ${anchors.join(", ")}` : "")).join(""), "chip-row");
}
function requirementRow(entry, ctx) {
  return `<div class="prism-lib-row" data-library-row>${titleCell(entry.path, ctx, entry.title, "list", entry.requirements ? plural(entry.requirements, "requirement") : "", entry.scope)}${cell(recordStatus(entry.status ?? ""))}${cell(escapeHtml(dated(entry, false)))}${assigned(entry, ctx)}</div>`;
}
function decisionRow(entry, ctx, titles) {
  const named = (paths) => paths.map((path) => titles.get(path) ?? documentTitle(path, ctx)).join(", ");
  const detail = entry.supersededBy?.length ? `Superseded by ${named(entry.supersededBy)}` : entry.supersedes?.length ? `Supersedes ${named(entry.supersedes)}` : "";
  const applies = [
    ...(entry.requirementLinks ?? []).map((link) => linkChip(link.path, ctx, documentTitle(link.path, ctx), link.anchors.length ? `req ${link.anchors.join(", ")}` : "")),
    ...(entry.initiatives ?? []).map((use) => linkChip(`initiative:${use.initiative}`, ctx, use.title, "initiative"))
  ];
  return `<div class="prism-lib-row" data-library-row>${titleCell(entry.path, ctx, entry.title, "scale", detail, entry.scope)}${cell(recordStatus(entry.status ?? ""))}${cell(escapeHtml(dated(entry, true)))}${applies.length ? cell(applies.join(""), "chip-row") : quiet("Nothing linked")}</div>`;
}
function diagramRow(diagram, about, ctx) {
  const facts = about[diagram.path] ?? {};
  const owner = facts.owner ? cell(artifactChip(facts.owner, ctx, diagram.owner.title), "chip-row") : quiet(diagram.owner.title);
  return `<div class="prism-lib-row" data-library-row>${titleCell(diagram.path, ctx, diagram.name, "diagram", "", diagram.scope)}${cell(escapeHtml(facts.kind ?? "Diagram"))}${owner}</div>`;
}
function grouped(entries, keyOf, order) {
  const groups = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    for (const key of [keyOf(entry)].flat()) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
  }
  return [...groups].sort(([left], [right]) => order(left, right));
}
const byName = (left, right) => left.localeCompare(right);
const lastly = (name) => (left, right) => (left === name) - (right === name) || byName(left, right);
function groupingOf(kind, grouping, data) {
  if (grouping === "scope") return { key: (entry) => entry.scope ?? "workspace", order: byScopeLabel, name: escapeHtml, source: scopeSource };
  if (grouping === "status") return { key: statusWord, order: (left, right) => statusRank(left) - statusRank(right) || byName(left, right), name: (word) => word === NO_STATUS ? NO_STATUS : recordStatus(word), source: () => "" };
  if (grouping === "area") return { key: areaOf, order: lastly("General"), name: escapeHtml, source: () => "" };
  if (grouping === "initiative") {
    const NONE = kind === "requirements" ? "Not assigned yet" : "Not linked from a design";
    const key = kind === "requirements" ? (entry) => entry.assignedTo?.length ? [...new Set(entry.assignedTo.map((use) => use.initiativeTitle ?? use.initiative))] : NONE : (entry) => entry.initiatives?.length ? entry.initiatives.map((use) => use.title) : NONE;
    return { key, order: lastly(NONE), name: escapeHtml, source: (title) => title === NONE ? "" : "initiative" };
  }
  if (grouping === "owner") {
    const NONE = "Not linked";
    return {
      key: (diagram) => !data.about?.[diagram.path]?.owner ? NONE : diagram.owner.kind === "decision" ? diagram.owner.title : diagram.owner.title.split(" \xB7 ")[0],
      order: lastly(NONE),
      name: escapeHtml,
      source: (name) => name === NONE ? "no record names it" : data.diagrams.find((diagram) => diagram.owner.kind === "decision" && diagram.owner.title === name) ? "decision" : "initiative"
    };
  }
  if (grouping === "kind") return { key: (diagram) => data.about?.[diagram.path]?.kind ?? "Diagram", order: byName, name: escapeHtml, source: () => "" };
  return null;
}
const LIBRARIES = Object.freeze({
  requirements: {
    noun: "requirements file",
    icon: "list",
    columns: ["Requirements file", "Status", "Date", "Assigned to"],
    entries: (data) => data.entries,
    text: (entry) => [entry.title, entry.status, ...(entry.assignedTo ?? []).map((use) => use.title)].join(" "),
    sub: (count) => `${count}: what the product must do, and which slices build each requirement.`,
    empty: (data) => emptyState("No requirements yet", data.directory ? "No requirement file exists yet." : "The workflow settings turn requirements off.")
  },
  decisions: {
    noun: "decision",
    icon: "scale",
    columns: ["Decision", "Status", "Created", "Applies to"],
    entries: (data) => data.entries,
    text: (entry) => [entry.title, entry.status, ...(entry.initiatives ?? []).map((use) => use.title)].join(" "),
    sub: (count) => `${count}: what was decided, why, and the work each one shapes.`,
    empty: (data) => emptyState("No decisions yet", data.directory ? "No decision record exists yet." : "The workflow settings turn decision records off.")
  },
  diagrams: {
    noun: "diagram",
    icon: "diagram",
    columns: ["Diagram", "Kind", "Belongs to"],
    entries: (data) => data.diagrams ?? [],
    text: (diagram, data) => [diagram.name, diagram.owner.title, data.about?.[diagram.path]?.kind].join(" "),
    sub: (count) => `${count} in the plans and decisions folders: what each one draws and what it belongs to.`,
    empty: () => emptyState("No diagrams yet", "No PlantUML file exists in the plans or decisions folders.")
  },
  // A workspace's glossary is each scope's own, listed term by term; a term that another scope also defines names that scope.
  glossary: {
    noun: "term",
    icon: "book",
    columns: ["Term", "Meaning", "Elsewhere"],
    entries: (data) => (data.glossaries ?? []).flatMap((glossary) => glossary.terms.map((term) => ({ ...term, scope: glossary.scope, path: glossary.ref }))),
    text: (entry) => [entry.term, entry.text].join(" "),
    sub: (count) => `${count}, each scope's from its own glossary.`,
    empty: () => emptyState("No terms yet", "No glossary defines a term yet.")
  }
});
const NOUNS = Object.freeze({ requirements: "requirements file", decisions: "decision", diagrams: "diagram", glossary: "term" });
function termRow(entry, ctx, elsewhere) {
  const others = elsewhere(entry);
  const also = others.length ? cell(`${others.map((label) => `<prism-chip data-scope-label>${escapeHtml(label)}</prism-chip>`).join("")}<span class="muted">${others.length === 1 ? "also defines it" : "also define it"}</span>`, "chip-row") : quiet("");
  return `<div class="prism-lib-row" data-library-row>${titleCell(entry.path, ctx, entry.term, "book", "", entry.scope)}${cell(escapeHtml(entry.text))}${also}</div>`;
}
function tableBody(kind, data, entries, grouping, ctx) {
  if (!entries.length) return '<p class="prism-lib-nothing">No record matches the filter.</p>';
  const titles = new Map((data.entries ?? []).map((entry) => [entry.path, entry.title]));
  const definers = /* @__PURE__ */ new Map();
  if (kind === "glossary") for (const entry of LIBRARIES.glossary.entries(data)) {
    const key = entry.term.toLowerCase();
    if (!definers.has(key)) definers.set(key, /* @__PURE__ */ new Set());
    definers.get(key).add(entry.scope);
  }
  const elsewhere = (entry) => [...definers.get(entry.term.toLowerCase()) ?? []].filter((label) => label !== entry.scope).sort(byScopeLabel);
  const row = kind === "requirements" ? (entry) => requirementRow(entry, ctx) : kind === "decisions" ? (entry) => decisionRow(entry, ctx, titles) : kind === "glossary" ? (entry) => termRow(entry, ctx, elsewhere) : (diagram) => diagramRow(diagram, data.about ?? {}, ctx);
  const by = groupingOf(kind, grouping, data);
  if (!by) return entries.map(row).join("");
  return grouped(entries, by.key, by.order).map(([key, members]) => `${groupHead(by.name(key), members.length, by.source(key))}${members.map(row).join("")}`).join("");
}
function toolbar(kind, grouping, filter, choices) {
  const library = LIBRARIES[kind];
  return `<div class="library-toolbar" role="toolbar" aria-label="${escapeHtml(library.columns[0])} list">
    <prism-field type="search" variant="filter" label="Filter" placeholder="Filter ${escapeHtml(kind)}" value="${escapeHtml(filter)}" class="library-filter" data-library-filter><prism-icon slot="start" name="filter" size="sm"></prism-icon></prism-field>
    <span class="library-toolbar-group"><span class="library-toolbar-label" aria-hidden="true">Group by</span><prism-segmented label="Group by" value="${grouping}" data-library-group>${choices.map(([value, label]) => `<span value="${value}">${label}</span>`).join("")}</prism-segmented></span>
  </div>`;
}
const matches = (text, filter) => {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
};
const scopesOf = (entries) => [...new Set(entries.map((entry) => entry.scope).filter(Boolean))].sort(byScopeLabel);
const andList = (labels) => labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
function renderLibrary(container, kind, data, ctx) {
  const library = LIBRARIES[kind];
  const every = library.entries(data);
  const scopes = scopesOf(every);
  const narrowed = ctx.scopeFilter?.() ?? null;
  const all = narrowed ? every.filter((entry) => !entry.scope || ctx.scopeShown(entry.scope)) : every;
  const count = narrowed ? `${all.length} of ${plural(every.length, NOUNS[kind])}` : `${plural(every.length, NOUNS[kind])}${scopes.length > 1 ? ` in ${plural(scopes.length, "scope")}` : ""}`;
  const note = narrowed ? `<p class="library-narrowed muted" data-library-narrowed>Narrowed to ${escapeHtml(andList(narrowed))}. <a href="#" data-show-all-scopes>Show all scopes</a></p>` : "";
  const sub = pageSub(escapeHtml(library.sub(count)));
  const bindNarrowed = () => container.querySelector("[data-show-all-scopes]")?.addEventListener("click", (event) => {
    event.preventDefault();
    ctx.showAllScopes?.();
  });
  if (!all.length) {
    const body2 = `${note}${every.length ? '<p class="prism-lib-nothing">No record of the chosen scopes.</p>' : library.empty(data)}`;
    container.innerHTML = setPageSub(container, sub, ctx) ? body2 : `${sub}${body2}`;
    bindNarrowed();
    return;
  }
  const key = `library.${kind}.groupBy`;
  ctx.state.libraryFilter ??= {};
  const choices = GROUPINGS[kind].filter(([value]) => value !== "scope" || scopes.length > 1);
  const effective = (value) => choices.some(([name]) => name === value) ? value : choices[0][0];
  let grouping = effective(preference(key));
  const filter = () => ctx.state.libraryFilter[kind] ?? "";
  const body = `${note}${toolbar(kind, grouping, filter(), choices)}<prism-lib-table class="library-table is-${kind}">${head(library.columns)}<div class="library-rows" data-library-rows></div></prism-lib-table>`;
  container.innerHTML = setPageSub(container, sub, ctx) ? body : `${sub}${body}`;
  bindNarrowed();
  const rows = container.querySelector("[data-library-rows]");
  const draw = () => {
    const shown = all.filter((entry) => matches(library.text(entry, data), filter()));
    rows.innerHTML = tableBody(kind, data, shown, grouping, { ...ctx, groupedByScope: grouping === "scope" });
    bindLinks(rows, ctx);
  };
  draw();
  const field = container.querySelector("[data-library-filter]");
  field.addEventListener("input", () => {
    ctx.state.libraryFilter[kind] = field.value ?? "";
    draw();
  });
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !field.value) return;
    event.preventDefault();
    event.stopPropagation();
    field.value = "";
    ctx.state.libraryFilter[kind] = "";
    draw();
  });
  container.querySelector("[data-library-group]").addEventListener("change", (event) => {
    const value = event.detail?.value;
    if (!choices.some(([name]) => name === value)) return;
    grouping = value;
    void setPreference(key, value).catch(() => ctx.showToast?.("The grouping changed here, but the review app could not store the choice."));
    draw();
  });
}
function render(container, entity, ctx) {
  const data = entity.data;
  if (entity.kind === "glossary" && Array.isArray(data.glossaries)) {
    renderLibrary(container, "glossary", data, ctx);
    bindLinks(container, ctx);
    return;
  }
  if (entity.kind === "glossary") {
    container.innerHTML = data.exists ? `<section class="view-section document-sheet"><prism-doc class="document-content">${ctx.renderMarkdown(data.content, data.path)}</prism-doc></section>` : card("No glossary yet", data.path ? `<p>The configured glossary does not exist yet.</p><p class="muted">Run <code>setup</code> or <code>ideate</code> to create it.</p>` : "<p>The workflow settings turn the glossary off.</p>", { eyebrow: "Glossary" });
    return;
  }
  renderLibrary(container, entity.kind, data, ctx);
  bindLinks(container, ctx);
}
export {
  render
};
