import { preference, setPreference } from "../kit/preferences.js";
import { artifactChip, artifactLink, bindLinks, card, documentTitle, emptyState, escapeHtml, pageSub, plural, recordStatus, setPageSub, shortDate } from "./util.js";
import { formatBadge, formatBanner } from "./format-marks.js";

// Knowledge's libraries of requirements, decisions, and diagrams: one kit library table each, with a filter and a Group by choice above it.
// Each row is a record's title with a detail line, then its status, date, and what it is linked to; the grouping is the person's preference.

// Scope is offered only while the page lists records of more than one scope; otherwise a Scope choice groups as the next choice does.
const GROUPINGS: Readonly<Record<string, any>> = Object.freeze({
  requirements: [["scope", "Scope"], ["status", "Status"], ["area", "Area"], ["initiative", "Initiative"], ["none", "None"]],
  decisions: [["scope", "Scope"], ["area", "Area"], ["status", "Status"], ["initiative", "Initiative"], ["none", "None"]],
  diagrams: [["scope", "Scope"], ["owner", "Belongs to"], ["kind", "Kind"], ["none", "None"]],
  glossary: [["scope", "Scope"], ["none", "None"]]
});

// Statuses group in the order a record moves through them; any other status follows, by name, and a record without one comes last.
const STATUS_ORDER = ["Approved", "Accepted", "Proposed", "Draft", "Superseded", "Withdrawn", "Deprecated"];
const NO_STATUS = "No status";
const statusWord = (entry: any) => String(entry.status ?? "").trim().split(/\s+/)[0] || NO_STATUS;
const statusRank = (word: any) => word === NO_STATUS ? Infinity : STATUS_ORDER.indexOf(word) === -1 ? STATUS_ORDER.length : STATUS_ORDER.indexOf(word);

// The scope label of a store artifact in a workspace, which tells two scopes' files of one name apart, or nothing for a checkout's own file or while the rows group by scope.
function scopeChip(path: any, ctx: any, scope: any) {
  const label = scope ?? ctx.scopeLabel?.(path);
  return label && !ctx.groupedByScope ? `<prism-chip data-scope-label>${escapeHtml(label)}</prism-chip>` : "";
}

// Where a scope's records come from, beside its group's name.
const scopeSource = (label: string) => label === "workspace" ? "every repository" : label.includes("/") ? `component of ${label.split("/")[0]}` : "repository";
const byScopeLabel = (left: any, right: any) => (left === "workspace" ? -1 : right === "workspace" ? 1 : left.localeCompare(right));

const head = (columns: any) => `<div class="prism-lib-row is-head" aria-hidden="true">${columns.map((column: any) => `<span>${escapeHtml(column)}</span>`).join("")}</div>`;
const groupHead = (name: string, count: number, source = "") => `<div class="prism-lib-group"><h2 class="prism-lib-group-name">${name} <prism-badge tone="neutral">${count}</prism-badge></h2>${source ? `<span class="prism-lib-group-source">${escapeHtml(source)}</span>` : ""}</div>`;
const cell = (html: any, className = "") => `<span class="prism-lib-cell${className ? ` ${className}` : ""}">${html}</span>`;
const quiet = (text: string) => cell(escapeHtml(text), "muted");

// A record's title links to its page, after its kind's glyph, with a detail line below it when there is one; no line names a file, since the page names records by title.
// A file that breaks its format carries its mark after the title.
function titleCell(path: any, ctx: any, title: string, icon: any, detail = "", scope = null, format: any = null) {
  return `<span class="prism-lib-title"><prism-icon class="prism-lib-kind" name="${icon}" size="sm" aria-hidden="true"></prism-icon><span class="prism-lib-title-text">${artifactLink(path, ctx, title)}${scopeChip(path, ctx, scope)}${detail ? `<span class="prism-lib-cell is-detail">${escapeHtml(detail)}</span>` : ""}</span>${formatBadge(format)}</span>`;
}

// A link chip with quieter meta text, such as a slice with the requirements it builds.
function linkChip(ref: any, ctx: any, label: string, meta = "") {
  const chip = artifactChip(ref, ctx, label);
  return meta ? chip.replace(/<\/prism-chip>$/, `<span slot="meta">${escapeHtml(meta)}</span></prism-chip>`) : chip;
}

// A record's date as the page's other dates show it, with the word that says what happened then.
function dated(entry: any, decision: any) {
  if (!decision && entry.approved && shortDate(entry.approved)) return `Approved ${shortDate(entry.approved)}`;
  return entry.created && shortDate(entry.created) ? `${decision ? "" : "Created "}${shortDate(entry.created)}` : "";
}

const areaOf = (entry: any) => entry.topic ?? "General";

// The slices that build a requirements file, one chip each with the requirements it builds, in the order the initiatives cite them.
function assigned(entry: any, ctx: any) {
  const slices = new Map();
  for (const use of entry.assignedTo ?? []) {
    const key = `${use.initiative}/${use.slug}`;
    if (!slices.has(key)) slices.set(key, { use, anchors: [] });
    if (use.anchor && !slices.get(key).anchors.includes(use.anchor)) slices.get(key).anchors.push(use.anchor);
  }
  if (!slices.size) return quiet("Not assigned yet");
  return cell([...slices].map(([key, { use, anchors }]) => linkChip(`slice:${key}`, ctx, use.title, anchors.length ? `req ${anchors.join(", ")}` : "")).join(""), "chip-row");
}

function requirementRow(entry: any, ctx: any) {
  return `<div class="prism-lib-row" data-library-row>${titleCell(entry.path, ctx, entry.title, "list", entry.requirements ? plural(entry.requirements, "requirement") : "", entry.scope, entry.format ?? null)}${cell(recordStatus(entry.status ?? ""))}${cell(escapeHtml(dated(entry, false)))}${assigned(entry, ctx)}</div>`;
}

function decisionRow(entry: any, ctx: any, titles: any) {
  const named = (paths: string[]) => paths.map((path) => titles.get(path) ?? documentTitle(path, ctx)).join(", ");
  const detail = entry.supersededBy?.length ? `Superseded by ${named(entry.supersededBy)}` : entry.supersedes?.length ? `Supersedes ${named(entry.supersedes)}` : "";
  const applies = [
    ...(entry.requirementLinks ?? []).map((link: any) => linkChip(link.path, ctx, documentTitle(link.path, ctx), link.anchors.length ? `req ${link.anchors.join(", ")}` : "")),
    ...(entry.initiatives ?? []).map((use: any) => linkChip(`initiative:${use.initiative}`, ctx, use.title, "initiative"))
  ];
  return `<div class="prism-lib-row" data-library-row>${titleCell(entry.path, ctx, entry.title, "scale", detail, entry.scope, entry.format ?? null)}${cell(recordStatus(entry.status ?? ""))}${cell(escapeHtml(dated(entry, true)))}${applies.length ? cell(applies.join(""), "chip-row") : quiet("Nothing linked")}</div>`;
}

function diagramRow(diagram: any, about: any, ctx: any) {
  const facts = about[diagram.path] ?? {};
  const owner = facts.owner ? cell(artifactChip(facts.owner, ctx, diagram.owner.title), "chip-row") : quiet(diagram.owner.title);
  return `<div class="prism-lib-row" data-library-row>${titleCell(diagram.path, ctx, diagram.name, "diagram", "", diagram.scope)}${cell(escapeHtml(facts.kind ?? "Diagram"))}${owner}</div>`;
}

// Groups in the order the grouping gives, each with its rows; a record in two initiatives shows under each.
function grouped(entries: any, keyOf: any, order: any) {
  const groups = new Map();
  for (const entry of entries) {
    for (const key of [keyOf(entry)].flat()) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
  }
  return [...groups].sort(([left], [right]) => order(left, right));
}

const byName = (left: any, right: any) => left.localeCompare(right);
const lastly = (name: string) => (left: any, right: any) => ((left === name) as any) - ((right === name) as any) || byName(left, right);

// What each grouping groups by, the group's name as markup, and where it comes from, per library.
function groupingOf(kind: any, grouping: any, data: any) {
  if (grouping === "scope") return { key: (entry: any) => entry.scope ?? "workspace", order: byScopeLabel, name: escapeHtml, source: scopeSource };
  if (grouping === "status") return { key: statusWord, order: (left: any, right: any) => statusRank(left) - statusRank(right) || byName(left, right), name: (word: any) => word === NO_STATUS ? NO_STATUS : recordStatus(word), source: () => "" };
  if (grouping === "area") return { key: areaOf, order: lastly("General"), name: escapeHtml, source: () => "" };
  if (grouping === "initiative") {
    const NONE = kind === "requirements" ? "Not assigned yet" : "Not linked from a design";
    const key = kind === "requirements"
      ? (entry: any) => entry.assignedTo?.length ? [...new Set(entry.assignedTo.map((use: any) => use.initiativeTitle ?? use.initiative))] : NONE
      : (entry: any) => entry.initiatives?.length ? entry.initiatives.map((use: any) => use.title) : NONE;
    return { key, order: lastly(NONE), name: escapeHtml, source: (title: string) => title === NONE ? "" : "initiative" };
  }
  if (grouping === "owner") {
    const NONE = "Not linked";
    return {
      key: (diagram: any) => !data.about?.[diagram.path]?.owner ? NONE : diagram.owner.kind === "decision" ? diagram.owner.title : diagram.owner.title.split(" · ")[0],
      order: lastly(NONE), name: escapeHtml,
      source: (name: string) => name === NONE ? "no record names it" : data.diagrams.find((diagram: any) => diagram.owner.kind === "decision" && diagram.owner.title === name) ? "decision" : "initiative"
    };
  }
  if (grouping === "kind") return { key: (diagram: any) => data.about?.[diagram.path]?.kind ?? "Diagram", order: byName, name: escapeHtml, source: () => "" };
  return null;
}

const LIBRARIES: Readonly<Record<string, any>> = Object.freeze({
  requirements: {
    noun: "requirements file", icon: "list", columns: ["Requirements file", "Status", "Date", "Assigned to"],
    entries: (data: any) => data.entries,
    text: (entry: any) => [entry.title, entry.status, ...(entry.assignedTo ?? []).map((use: any) => use.title)].join(" "),
    sub: (count: number) => `${count}: what the product must do, and which slices build each requirement.`,
    empty: (data: any) => emptyState("No requirements yet", data.directory ? "No requirement file exists yet." : "The workflow settings turn requirements off.")
  },
  decisions: {
    noun: "decision", icon: "scale", columns: ["Decision", "Status", "Created", "Applies to"],
    entries: (data: any) => data.entries,
    text: (entry: any) => [entry.title, entry.status, ...(entry.initiatives ?? []).map((use: any) => use.title)].join(" "),
    sub: (count: number) => `${count}: what was decided, why, and the work each one shapes.`,
    empty: (data: any) => emptyState("No decisions yet", data.directory ? "No decision record exists yet." : "The workflow settings turn decision records off.")
  },
  diagrams: {
    noun: "diagram", icon: "diagram", columns: ["Diagram", "Kind", "Belongs to"],
    entries: (data: any) => data.diagrams ?? [],
    text: (diagram: any, data: any) => [diagram.name, diagram.owner.title, data.about?.[diagram.path]?.kind].join(" "),
    sub: (count: number) => `${count} in the plans and decisions folders: what each one draws and what it belongs to.`,
    empty: () => emptyState("No diagrams yet", "No PlantUML file exists in the plans or decisions folders.")
  },
  // A workspace's glossary is each scope's own, listed term by term; a term that another scope also defines names that scope.
  glossary: {
    noun: "term", icon: "book", columns: ["Term", "Meaning", "Elsewhere"],
    entries: (data: any) => (data.glossaries ?? []).flatMap((glossary: any) => glossary.terms.map((term: any) => ({ ...term, scope: glossary.scope, path: glossary.ref }))),
    text: (entry: any) => [entry.term, entry.text].join(" "),
    sub: (count: number) => `${count}, each scope's from its own glossary.`,
    empty: () => emptyState("No terms yet", "No glossary defines a term yet.")
  }
});

const NOUNS: Readonly<Record<string, any>> = Object.freeze({ requirements: "requirements file", decisions: "decision", diagrams: "diagram", glossary: "term" });

function termRow(entry: any, ctx: any, elsewhere: any) {
  const others = elsewhere(entry);
  const also = others.length ? cell(`${others.map((label: string) => `<prism-chip data-scope-label>${escapeHtml(label)}</prism-chip>`).join("")}<span class="muted">${others.length === 1 ? "also defines it" : "also define it"}</span>`, "chip-row") : quiet("");
  return `<div class="prism-lib-row" data-library-row>${titleCell(entry.path, ctx, entry.term, "book", "", entry.scope)}${cell(escapeHtml(entry.text))}${also}</div>`;
}

// The table's rows for the shown entries, grouped as chosen, or a line that says the filter matches nothing.
function tableBody(kind: any, data: any, entries: any, grouping: any, ctx: any) {
  if (!entries.length) return '<p class="prism-lib-nothing">No record matches the filter.</p>';
  const titles = new Map((data.entries ?? []).map((entry: any) => [entry.path, entry.title]));
  const definers = new Map();
  if (kind === "glossary") for (const entry of LIBRARIES.glossary.entries(data)) {
    const key = entry.term.toLowerCase();
    if (!definers.has(key)) definers.set(key, new Set());
    definers.get(key).add(entry.scope);
  }
  const elsewhere = (entry: any) => [...(definers.get(entry.term.toLowerCase()) ?? [])].filter((label) => label !== entry.scope).sort(byScopeLabel);
  const row = kind === "requirements" ? (entry: any) => requirementRow(entry, ctx) : kind === "decisions" ? (entry: any) => decisionRow(entry, ctx, titles) : kind === "glossary" ? (entry: any) => termRow(entry, ctx, elsewhere) : (diagram: any) => diagramRow(diagram, data.about ?? {}, ctx);
  const by = groupingOf(kind, grouping, data);
  if (!by) return entries.map(row).join("");
  return grouped(entries, by.key, by.order).map(([key, members]) => `${groupHead(by.name(key), members.length, by.source(key))}${members.map(row).join("")}`).join("");
}

function toolbar(kind: any, grouping: any, filter: any, choices: any) {
  const library = LIBRARIES[kind];
  return `<div class="library-toolbar" role="toolbar" aria-label="${escapeHtml(library.columns[0])} list">
    <prism-field type="search" variant="filter" label="Filter" placeholder="Filter ${escapeHtml(kind)}" value="${escapeHtml(filter)}" class="library-filter" data-library-filter><prism-icon slot="start" name="filter" size="sm"></prism-icon></prism-field>
    <span class="library-toolbar-group"><span class="library-toolbar-label" aria-hidden="true">Group by</span><prism-segmented label="Group by" value="${grouping}" data-library-group>${choices.map(([value, label]: any) => `<span value="${value}">${label}</span>`).join("")}</prism-segmented></span>
  </div>`;
}

const matches = (text: string, filter: any) => {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = text.toLowerCase();
  return words.every((word: any) => haystack.includes(word));
};

// Scope labels in their listed order: the workspace first, then by label.
const scopesOf = (entries: any) => [...new Set(entries.map((entry: any) => entry.scope).filter(Boolean))].sort(byScopeLabel);

const andList = (labels: any) => labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;

/**
 * One library page, `requirements`, `decisions`, `diagrams`, or a workspace's `glossary`, drawn into `container` with its line under the page's title.
 * In a workspace the page lists the records of the scopes that Knowledge's scope filter shows, and says what it is narrowed to.
 */
function renderLibrary(container: any, kind: any, data: any, ctx: any) {
  const library = LIBRARIES[kind];
  const every = library.entries(data);
  const scopes = scopesOf(every);
  const narrowed = ctx.scopeFilter?.() ?? null;
  const all = narrowed ? every.filter((entry: any) => !entry.scope || ctx.scopeShown(entry.scope)) : every;
  const count = narrowed ? `${all.length} of ${plural(every.length, NOUNS[kind])}` : `${plural(every.length, NOUNS[kind])}${scopes.length > 1 ? ` in ${plural(scopes.length, "scope")}` : ""}`;
  const note = narrowed ? `<p class="library-narrowed muted" data-library-narrowed>Narrowed to ${escapeHtml(andList(narrowed))}. <a href="#" data-show-all-scopes>Show all scopes</a></p>` : "";
  // The line under the title also counts the shown files that break their format.
  const broken = all.filter((entry: any) => entry.format).length;
  const sub = pageSub(`${escapeHtml(library.sub(count))}${broken ? ` · <b>${broken} of ${all.length}</b> ${broken === 1 ? "breaks its" : "break their"} format` : ""}`);
  const bindNarrowed = () => container.querySelector("[data-show-all-scopes]")?.addEventListener("click", (event: any) => {
    event.preventDefault();
    ctx.showAllScopes?.();
  });
  if (!all.length) {
    const body = `${note}${every.length ? '<p class="prism-lib-nothing">No record of the chosen scopes.</p>' : library.empty(data)}`;
    container.innerHTML = setPageSub(container, sub, ctx) ? body : `${sub}${body}`;
    bindNarrowed();
    return;
  }
  const key = `library.${kind}.groupBy`;
  ctx.state.libraryFilter ??= {};
  // Scope is a choice only while the records lie in more than one scope, and a stored Scope groups as the next choice otherwise.
  const choices = GROUPINGS[kind].filter(([value]: any) => value !== "scope" || scopes.length > 1);
  const effective = (value: any) => choices.some(([name]: any) => name === value) ? value : choices[0][0];
  let grouping = effective(preference(key));
  const filter = () => ctx.state.libraryFilter[kind] ?? "";
  const body = `${note}${toolbar(kind, grouping, filter(), choices)}<prism-lib-table class="library-table is-${kind}">${head(library.columns)}<div class="library-rows" data-library-rows></div></prism-lib-table>`;
  container.innerHTML = setPageSub(container, sub, ctx) ? body : `${sub}${body}`;
  bindNarrowed();
  const rows = container.querySelector("[data-library-rows]");
  const draw = () => {
    const shown = all.filter((entry: any) => matches(library.text(entry, data), filter()));
    rows.innerHTML = tableBody(kind, data, shown, grouping, { ...ctx, groupedByScope: grouping === "scope" });
    bindLinks(rows, ctx);
  };
  draw();
  // The filter draws only the rows, so the field keeps its focus and its text while the person types.
  const field = container.querySelector("[data-library-filter]");
  field.addEventListener("input", () => {
    ctx.state.libraryFilter[kind] = field.value ?? "";
    draw();
  });
  field.addEventListener("keydown", (event: any) => {
    if (event.key !== "Escape" || !field.value) return;
    event.preventDefault();
    event.stopPropagation();
    field.value = "";
    ctx.state.libraryFilter[kind] = "";
    draw();
  });
  container.querySelector("[data-library-group]").addEventListener("change", (event: any) => {
    const value = event.detail?.value;
    if (!choices.some(([name]: any) => name === value)) return;
    grouping = value;
    void setPreference(key, value).catch(() => ctx.showToast?.("The grouping changed here, but the review app could not store the choice."));
    draw();
  });
}

export function render(container: any, entity: any, ctx: any) {
  const data = entity.data;
  if (entity.kind === "glossary" && Array.isArray(data.glossaries)) {
    renderLibrary(container, "glossary", data, ctx);
    bindLinks(container, ctx);
    return;
  }
  if (entity.kind === "glossary") {
    container.innerHTML = data.exists
      ? `${formatBanner(data.format)}<section class="view-section document-sheet"><prism-doc class="document-content">${ctx.renderMarkdown(data.content, data.path)}</prism-doc></section>`
      : card("No glossary yet", data.path ? `<p>The configured glossary does not exist yet.</p><p class="muted">Run <code>setup</code> or <code>ideate</code> to create it.</p>` : "<p>The workflow settings turn the glossary off.</p>", { eyebrow: "Glossary" });
    return;
  }
  renderLibrary(container, entity.kind, data, ctx);
  bindLinks(container, ctx);
}
