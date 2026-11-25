// The approved Code place mockups: kit markup that draws the Code sidebar and page, injected into the demo app in place of its own; scenes.json lists the six approved scenes and their pictures.
// Mock of a Code place: its sidebar lists work items and other branches, its page is the files tree beside one file.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const agent = (name, live = true) => `<prism-avatar slot="end" kind="agent" name="${esc(name)}" size="sm"${live ? " live" : ""}></prism-avatar>`;
const person = (name, hue) => `<prism-avatar slot="end" kind="person" name="${esc(name)}" hue="${hue}" size="sm"></prism-avatar>`;
const meta = (t) => `<span slot="end" class="nav-meta">${esc(t)}</span>`;
const flag = (t, tone = "is-warning") => `<span slot="end" class="prism-tree-flag ${tone}">${esc(t)}</span>`;
const icon = (n) => `<prism-icon slot="start" name="${n}" size="sm" aria-hidden="true"></prism-icon>`;
const item = (value, label, { start = "", end = "", children = "", expanded = false, selected = false, tip = "" } = {}) =>
  `<prism-tree-item value="${esc(value)}" label="${esc(label)}"${expanded ? " expanded" : ""}${selected ? " selected" : ""}${tip ? ` tip="${esc(tip)}"` : ""}>${start}${end}${children}</prism-tree-item>`;
const phase = (p, label) => `<prism-phase slot="start" phase="${p}" label="${esc(label)}"></prism-phase>`;
const status = (v, label) => `<prism-status slot="start" value="${v}" label="${esc(label)}" glyph-only></prism-status>`;
const heading = (t, n) => `<h3 class="prism-group-heading"><span>${esc(t)}</span><span class="prism-group-count">${n}</span></h3>`;

// pick: "" for All, or the value of the picked row.
export function sidebar(pick = "") {
  const sel = (v) => pick === v;
  const branch = (v, repo, name, end, tip) => item(v, `${repo} · ${name}`, { start: icon("branch"), end, tip, selected: sel(v) });
  return `<prism-field type="search" variant="filter" label="Filter work and branches" placeholder="Filter work and branches" class="nav-filter"><prism-icon name="filter" slot="start" size="sm"></prism-icon></prism-field>
  <prism-tree label="Code">${item("all", "All work and branches", { start: icon("code"), end: meta("6"), selected: sel("") })}</prism-tree>
  ${heading("In progress", 1)}
  <prism-tree label="In progress" branching>
    ${item("i:retry", "Harden request retries", { start: status("in-progress", "In progress"), end: meta("8"), expanded: true, tip: "Harden request retries · In progress · 8 files changed", children: [
      item("s:observe", "Observe retry behavior", { start: status("in-progress", "Split · In progress"), end: `${agent("Claude on vm")}${meta("4")}`, expanded: true, tip: "Observe retry behavior · api · codex/retry-metrics, from main · web · codex/retry-metrics, from develop · Claude on vm · 4 files changed", children: [
        branch("b:metrics-api", "api", "codex/retry-metrics", meta("2"), "api · codex/retry-metrics, from main · Claude on vm · 2 files changed"),
        branch("b:metrics-web", "web", "codex/retry-metrics", meta("2"), "web · codex/retry-metrics, from develop · Claude on vm · 2 files changed")
      ].join("") }),
      item("s:deadline", "Retry timed-out requests until a total deadline", { start: phase("design", "Design · In progress"), end: `${flag("Waits")}${agent("Michael on mbp")}${meta("5")}`, selected: sel("s:deadline"), tip: "Retry timed-out requests until a total deadline · api · claude/retry-deadline, from main · Claude Code · 5 files changed" })
    ].join("") })}
  </prism-tree>
  ${heading("Other branches", 3)}
  <prism-tree label="Other branches">
    ${branch("o:feature", "web", "feature/report-table", `${person("Dana Kim", 2)}${meta("2")}`, "web · feature/report-table, from develop · Dana Kim · pushed 2 days ago")}
    ${branch("o:develop", "web", "develop", `${person("5 people", 3)}${meta("18")}`, "web · develop, from main · 5 people · pushed 3 h ago")}
    ${branch("o:release", "infra", "release/2026.11", `${person("Sam Ortiz", 4)}${meta("1")}`, "infra · release/2026.11, from main · Sam Ortiz · pushed 5 days ago")}
  </prism-tree>
  <p class="prism-foot-note"><span class="prism-foot-note-glyph"><prism-icon name="clock" size="xs"></prism-icon></span><span>6 quiet branches are hidden: no push in 30 days. <a href="#">Show them</a></span></p>`;
}

// The files tree: repositories at the top, component badges on the folders their workspace config declares.
const comp = (name, tip = "") => `<prism-chip slot="end" class="cv-comp" tone="neutral"${tip ? ` tip="${esc(tip)}"` : ""}><prism-icon slot="start" name="layers" size="xs" aria-hidden="true"></prism-icon>${esc(name)}</prism-chip>`;
// The people marks: an owning slice's agent as the Code answers name it, its claim's host and model or Agent, and a person of a branch nobody owns.
const PEOPLE = { "Dana Kim": 2, "5 people": 3 };
const who = (...names) => `<span slot="end" class="cv-who">${names.map((n) => n in PEOPLE ? `<prism-avatar kind="person" name="${esc(n)}" hue="${PEOPLE[n]}" size="sm"></prism-avatar>` : `<prism-avatar kind="agent" name="${esc(n)}" size="sm"></prism-avatar>`).join("")}</span>`;
const METRICS = "Claude Code · claude-sonnet-5-5";
const folder = (label, inner, { end = "", open = true, repo = false, dim = false } = {}) => `<prism-tree-item label="${esc(label)}" value="${esc(label)}"${open ? " expanded" : ""}${dim ? ' class="cv-dim"' : ""}>${icon(repo ? "code" : "tree")}${end}${inner}</prism-tree-item>`;
const file = (label, { end = "", selected = false, dim = false } = {}) => `<prism-tree-item label="${esc(label)}" value="${esc(label)}"${selected ? " selected" : ""}${dim ? ' class="cv-dim"' : ""}>${icon("file")}${end}</prism-tree-item>`;

export function filesTree({ only = false } = {}) {
  const skip = (touched) => only && !touched;
  const f = (label, touched, opts) => skip(touched) ? "" : file(label, opts);
  const api = folder("api", [
    folder("src", [
      folder("retry", [
        f("strategy.ts", true, { end: only ? `${flag("2 versions")}${who("Claude Code")}` : `${flag("3 versions")}${who("Claude Code", METRICS)}`, selected: true }),
        f("deadline.ts", true, { end: `${flag("New", "is-muted")}${who("Claude Code")}` }),
        f("legacy.ts", true, { end: `${flag("Removed", "is-muted")}${who("Claude Code")}` }),
        f("metrics.ts", !only, { end: only ? "" : `${flag("New", "is-muted")}${who(METRICS)}` }),
        f("backoff.ts", false, {})
      ].join(""), { end: comp("retry") }),
      folder("http", f("client.ts", true, { end: `${flag("2 versions")}${who("Claude Code")}` }), { end: comp("http-client") }),
      only ? "" : folder("reports", "", { open: false, end: comp("reports") })
    ].join("")),
    folder("docs", f("retries.feature", true, { end: `${flag("2 versions")}${who("Claude Code")}` })),
    f("package.json", false, {})
  ].join(""), { repo: true });
  const web = only ? "" : folder("web", [
    folder("packages", [
      folder("reports", "", { open: false, end: `${comp("report-ui")}${who("Agent", "Dana Kim")}` }),
      folder("charts", "", { open: false, end: `${comp("charts", "Declared only on feature/report-table")}${flag("1 branch", "is-muted")}` }),
      folder("shell", "", { open: false, end: `${comp("shell")}${who("5 people")}` })
    ].join(""))
  ].join(""), { repo: true });
  const infra = only ? "" : folder("infra", "", { repo: true, open: false, end: comp("infra", "The whole repository is one component") });
  return `<prism-tree label="Files of every repository" class="cv-tree">${api}${web}${infra}</prism-tree>`;
}

// The difference of each version of api/src/retry/strategy.ts from its fork on main: the deadline slice's, and the metrics slice's, which opens first on All work and branches because its slice comes first in the sidebar.
const DEADLINE = [
  ["same", 1, 1, "export class RequestRetryStrategy {"],
  ["del", 2, null, "  constructor(private attempts = 3) {}"],
  ["add", null, 2, "  constructor(private attempts = 3, private deadlineMs = 10_000) {}"],
  ["same", 3, 3, ""],
  ["del", 4, null, "  shouldRetry(error: Error, attempt: number) {"],
  ["add", null, 4, "  shouldRetry(error: Error, attempt: number, elapsedMs: number) {"],
  ["add", null, 5, "    if (elapsedMs >= this.deadlineMs) return false;"],
  ["same", 5, 6, "    return attempt < this.attempts && error.name === \"TimeoutError\";"],
  ["same", 6, 7, "  }"],
  ["same", 7, 8, ""],
  ["same", 8, 9, "  delayFor(attempt: number) {"],
  ["same", 9, 10, "    return Math.min(2 ** attempt * 100, 2_000);"],
  ["same", 10, 11, "  }"],
  ["same", 11, 12, "}"]
];
const METRICS_DIFF = [
  ["add", null, 1, "import { RetryMetrics } from \"./metrics\";"],
  ["add", null, 2, ""],
  ["same", 1, 3, "export class RequestRetryStrategy {"],
  ["del", 2, null, "  constructor(private attempts = 3) {}"],
  ["add", null, 4, "  constructor(private attempts = 3, private metrics = new RetryMetrics()) {}"],
  ["same", 3, 5, ""],
  ["same", 4, 6, "  shouldRetry(error: Error, attempt: number) {"],
  ["same", 5, 7, "    return attempt < this.attempts && error.name === \"TimeoutError\";"],
  ["same", 6, 8, "  }"],
  ["same", 7, 9, ""],
  ["same", 8, 10, "  delayFor(attempt: number) {"],
  ["add", null, 11, "    this.metrics.retried(attempt);"],
  ["same", 9, 12, "    return Math.min(2 ** attempt * 100, 2_000);"],
  ["same", 10, 13, "  }"],
  ["same", 11, 14, "}"]
];
const diffTable = (rows) => `<div class="diff-scroll cv-code"><table class="line-diff"><tbody>${rows.map(([op, a, b, t]) => `<tr class="diff-${op}"><td class="diff-num">${a ?? ""}</td><td class="diff-num">${b ?? ""}</td><td class="diff-text"><span class="diff-mark" aria-hidden="true">${op === "add" ? "+" : op === "del" ? "−" : " "}</span>${esc(t)}</td></tr>`).join("")}</tbody></table></div>`;

const chip = (label, metaText, { pressed = false, start = "", tip = "" } = {}) => `<prism-chip interactive pressed="${pressed}"${tip ? ` tip="${esc(tip)}"` : ""}>${start}${esc(label)}<span slot="meta">${metaText}</span></prism-chip>`;
export function fileView({ picked = false } = {}) {
  const av = (k, n) => `<prism-avatar slot="start" kind="${k}" name="${n}" size="sm"></prism-avatar>`;
  return `<div class="cv-file">
    <div class="cv-file-head"><span class="cv-path"><span class="cv-repo">api</span> / src/retry/strategy.ts</span><prism-chip tone="neutral" class="cv-comp"><prism-icon slot="start" name="layers" size="xs" aria-hidden="true"></prism-icon>retry</prism-chip></div>
    <div class="cv-versions" role="group" aria-label="Versions of this file">
      ${chip("main", "base", { start: `<prism-icon slot="start" name="check-circle" size="xs"></prism-icon>`, tip: "The file on main" })}
      ${picked ? "" : chip("Emit retry metrics", `<span class="cv-add">+4</span> <span class="cv-del">−1</span>`, { pressed: true, start: av("agent", METRICS), tip: `api · codex/retry-metrics, from main · ${METRICS}` })}
      ${chip("Retry timed-out requests until a total deadline", `<span class="cv-add">+3</span> <span class="cv-del">−2</span> · verified`, { pressed: picked, start: av("agent", "Claude Code"), tip: "api · claude/retry-deadline, from main · Claude Code" })}
    </div>
    ${picked ? "" : `<p class="cv-overlap"><prism-icon name="warning" size="xs" aria-hidden="true"></prism-icon><span>Retry timed-out requests until a total deadline also changes lines 2–2, so whichever merges second will conflict.</span></p>`}
    ${diffTable(picked ? DEADLINE : METRICS_DIFF)}
  </div>`;
}

export function page({ picked = false, only = false, mode = "both" } = {}) {
  if (mode === "file") return `<div class="cv-ide cv-one"><section class="cv-view"><prism-button size="sm" variant="ghost" class="cv-back"><prism-icon name="back" size="xs" aria-hidden="true"></prism-icon><span>Files</span></prism-button>${fileView({ picked })}</section></div>`;
  return `<div class="cv-ide${mode === "tree" ? " cv-one" : ""}">
    <aside class="cv-tree-pane">
      <div class="cv-tree-tools">${picked ? `<p class="cv-scope">Showing what <b>Retry timed-out requests until a total deadline</b> changes</p>` : ""}<prism-segmented label="Files" value="${only ? "touched" : "all"}"><prism-option value="all"${only ? "" : " selected"}>All files</prism-option><prism-option value="touched"${only ? " selected" : ""}>Touched</prism-option></prism-segmented></div>
      ${filesTree({ only })}
    </aside>
    ${mode === "tree" ? "" : `<section class="cv-view">${fileView({ picked })}</section>`}
  </div>`;
}

export const CSS = `
#artifact.cv-host{padding:0}
.cv-ide{display:grid;grid-template-columns:minmax(240px,320px) minmax(0,1fr);height:100%;min-height:0}
.cv-tree-pane{border-inline-end:1px solid var(--prism-color-line);padding:var(--prism-space-2);overflow:auto;display:flex;flex-direction:column;gap:var(--prism-space-2)}
.cv-tree-tools{display:flex;flex-direction:column;gap:var(--prism-space-2)}
.cv-scope{margin:0;font-size:var(--prism-font-size-sm);color:var(--prism-color-ink-muted)}
.cv-view{overflow:auto;padding:var(--prism-space-3) var(--prism-space-4)}
.cv-file{display:flex;flex-direction:column;gap:var(--prism-space-2)}
.cv-file-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--prism-space-2)}
.cv-path{font-family:var(--prism-font-code);font-size:var(--prism-font-size-md)}
.cv-repo{color:var(--prism-color-ink-muted)}
.cv-versions{display:flex;flex-wrap:wrap;gap:var(--prism-space-2)}
.cv-overlap{display:flex;align-items:center;gap:var(--prism-space-2);margin:0;color:var(--prism-color-warning);font-size:var(--prism-font-size-sm)}
.cv-add{color:var(--prism-color-diff-added)} .cv-del{color:var(--prism-color-diff-removed)}
.cv-who{display:inline-flex;gap:2px}
.cv-dim > .prism-tree-row{color:var(--prism-color-ink-faint)}
.cv-code .line-diff{width:100%}
.cv-one{grid-template-columns:minmax(0,1fr)}.cv-one .cv-tree-pane{border-inline-end:0}.cv-back{align-self:flex-start;margin-bottom:var(--prism-space-2)}
@media (max-width:760px){.cv-ide{grid-template-columns:minmax(0,1fr)}.cv-tree-pane{border-inline-end:0}}
`;
