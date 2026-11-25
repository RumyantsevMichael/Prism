// The approved Code place mockups: kit markup that draws the Code sidebar and page, injected into the demo app in place of its own; scenes.json lists the six approved scenes and their pictures.
// Mock of a Code place: its sidebar lists work items and other branches, its page is the files tree beside one file.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const agent = (name, live = true) => `<prism-avatar slot="end" kind="agent" name="${esc(name)}" size="sm"${live ? " live" : ""}></prism-avatar>`;
const person = (name) => `<prism-avatar slot="end" kind="person" name="${esc(name)}" size="sm"></prism-avatar>`;
// The agent that the Code demo's Prism server names itself, which the Code answers give as the owner of each verified line of work.
const CLIENT = "repository-names-test";
const meta = (t) => `<span slot="end" class="nav-meta">${esc(t)}</span>`;
const flag = (t, tone = "is-warning") => `<span slot="end" class="prism-tree-flag ${tone}">${esc(t)}</span>`;
const icon = (n) => `<prism-icon slot="start" name="${n}" size="sm" aria-hidden="true"></prism-icon>`;
const item = (value, label, { start = "", end = "", children = "", expanded = false, selected = false, tip = "" } = {}) =>
  `<prism-tree-item value="${esc(value)}" label="${esc(label)}"${expanded ? " expanded" : ""}${selected ? " selected" : ""}${tip ? ` tip="${esc(tip)}"` : ""}>${start}${end}${children}</prism-tree-item>`;
const phase = (p, label) => `<prism-phase slot="start" phase="${p}" label="${esc(label)}"></prism-phase>`;
const status = (v, label) => `<prism-status slot="start" value="${v}" label="${esc(label)}" glyph-only></prism-status>`;
const heading = (t, n) => `<h3 class="prism-group-heading"><span>${esc(t)}</span><span class="prism-group-count">${n}</span></h3>`;

// pick: "" for All, or the value of the picked row; host is the claim label that the Code demo's verifications record, the short host name of the machine that runs them.
export function sidebar(pick = "", { host = "host" } = {}) {
  const sel = (v) => pick === v;
  const branch = (v, repo, name, end, tip) => item(v, `${repo} · ${name}`, { start: icon("branch"), end, tip, selected: sel(v) });
  return `<prism-field type="search" variant="filter" label="Filter work and branches" placeholder="Filter work and branches" class="nav-filter"><prism-icon name="filter" slot="start" size="sm"></prism-icon></prism-field>
  <prism-tree label="Code">${item("all", "All work and branches", { start: icon("code"), end: meta("10"), selected: sel(""), tip: "All work and branches · 10 lines of work" })}</prism-tree>
  ${heading("In progress", 3)}
  <prism-tree label="In progress" branching>
    ${item("i:retries", "Harden request retries", { start: status("in-progress", "In progress"), end: meta("6"), expanded: true, tip: "Harden request retries · In progress · 6 files changed", children: [
      item("s:deadline", "Retry timed-out requests until a deadline", { start: phase("build", "Build · In progress"), end: `${agent(host)}${meta("5")}`, selected: sel("s:deadline"), tip: `Retry timed-out requests until a deadline · api · claude/retry-deadline, from main · ${CLIENT} · 5 files changed` }),
      item("s:metrics", "Report retry attempts as metrics", { start: phase("build", "Build · In progress"), end: `${agent(host)}${meta("2")}`, selected: sel("s:metrics"), tip: `Report retry attempts as metrics · api · codex/retry-metrics, from main · ${CLIENT} · 2 files changed` })
    ].join("") })}
    ${item("i:export", "Export activity reports", { start: status("in-progress", "In progress"), end: meta("3"), expanded: true, tip: "Export activity reports · In progress · 3 files changed", children:
      item("s:download", "Download signed reports", { start: status("in-progress", "Split · In progress"), end: `${agent(host)}${meta("3")}`, expanded: true, tip: `Download signed reports · api · claude/signed-download, from main · api · claude/signed-download-ui, from main · ${CLIENT} · 3 files changed`, children: [
        branch("b:download", "api", "claude/signed-download", meta("2"), `api · claude/signed-download, from main · ${CLIENT} · 2 files changed`),
        branch("b:download-ui", "api", "claude/signed-download-ui", meta("1"), `api · claude/signed-download-ui, from main · ${CLIENT} · 1 file changed`)
      ].join("") }) })}
    ${item("i:tidy", "Tidy retry limits", { start: status("in-progress", "In progress"), end: `${agent(host)}${meta("1")}`, tip: `Tidy retry limits · api · claude/tidy, from main · ${CLIENT} · 1 file changed` })}
  </prism-tree>
  ${heading("Other branches", 5)}
  <prism-tree label="Other branches">
    ${branch("o:review", "api", "review/deadline", `${person("Dana Kim")}${meta("1")}`, "api · review/deadline, from main · Dana Kim · 1 file changed")}
    ${branch("o:charts", "web", "feature/charts", `${person("Dana Kim")}${meta("2")}`, "web · feature/charts, from main · Dana Kim · 2 files changed")}
    ${branch("o:http", "api", "feature/http", `${person("Dana Kim")}${meta("1")}`, "api · feature/http, from main · Dana Kim · 1 file changed")}
    ${branch("o:release", "api", "release/2026.11", `${person("Sam Ortiz")}${meta("1")}`, "api · release/2026.11, from main · Sam Ortiz · 1 file changed")}
    ${branch("o:pages", "api", "gh-pages", person("Ana Ruiz"), "api · gh-pages, sharing no history with another branch · Ana Ruiz")}
  </prism-tree>
  <p class="prism-foot-note"><span class="prism-foot-note-glyph"><prism-icon name="clock" size="xs"></prism-icon></span><span>1 quiet branch is hidden: no push in 30 days. <a href="#">Show them</a></span></p>`;
}

// The files tree: repositories at the top in name order, a component badge on each folder or repository that is a component, Off on a repository with code content off.
const comp = (name, { tip = "", count = "" } = {}) => `<prism-chip slot="end" class="cv-comp" tone="neutral"${tip ? ` tip="${esc(tip)}"` : ""}><prism-icon slot="start" name="layers" size="xs" aria-hidden="true"></prism-icon>${esc(name)}${count ? `<span slot="meta">${esc(count)}</span>` : ""}</prism-chip>`;
// The people marks: the agent that the Code answers name for an owning slice's verification, and a person of a branch nobody owns.
const who = (...names) => `<span slot="end" class="cv-who">${names.map((n) => n === CLIENT ? `<prism-avatar kind="agent" name="${esc(n)}" size="sm"></prism-avatar>` : `<prism-avatar kind="person" name="${esc(n)}" size="sm"></prism-avatar>`).join("")}</span>`;
const folder = (label, inner, { end = "", open = true, repo = false, dim = false } = {}) => `<prism-tree-item label="${esc(label)}" value="${esc(label)}"${open ? " expanded" : ""}${dim ? ' class="cv-dim"' : ""}>${icon(repo ? "code" : "tree")}${end}${inner}</prism-tree-item>`;
const file = (label, { end = "", selected = false, dim = false } = {}) => `<prism-tree-item label="${esc(label)}" value="${esc(label)}"${selected ? " selected" : ""}${dim ? ' class="cv-dim"' : ""}>${icon("file")}${end}</prism-tree-item>`;

export function filesTree({ only = false } = {}) {
  const skip = (touched) => only && !touched;
  const f = (label, touched, opts) => skip(touched) ? "" : file(label, opts);
  const d = (label, touched, inner, opts) => skip(touched) ? "" : folder(label, inner, opts);
  const api = folder("api", [
    d(".prism", false, "", { open: false }),
    d("assets", false, "", { open: false }),
    folder("docs", f("retries.feature", true, { end: `${flag("2 versions")}${who(CLIENT)}` })),
    folder("src", [
      folder("http", f("client.ts", true, { end: only ? `${flag("2 versions")}${who(CLIENT)}` : `${flag("3 versions")}${who(CLIENT, "Dana Kim")}` })),
      d("reports", false, ["button.ts", "route.ts", "sign.ts"].map((name) => file(name, { end: `${flag("New", "is-muted")}${who(CLIENT)}` })).join("")),
      folder("retry", [
        f("backoff.ts", false, {}),
        f("deadline.ts", true, { end: `${flag("New", "is-muted")}${who(CLIENT)}` }),
        f("legacy.ts", true, { end: `${flag("Removed", "is-muted")}${who(CLIENT)}` }),
        f("metrics.ts", false, { end: `${flag("New", "is-muted")}${who(CLIENT)}` }),
        f("strategy.ts", true, { end: only ? `${flag("2 versions")}${who(CLIENT)}` : `${flag("4 versions")}${who(CLIENT, "Dana Kim")}`, selected: true })
      ].join(""))
    ].join("")),
    d("test", false, "", { open: false }),
    f("README.md", false, {}),
    f("check.mjs", false, {}),
    f("package.json", false, { end: `${flag("2 versions")}${who("Sam Ortiz")}` })
  ].join(""), { repo: true, end: comp("api") });
  const infra = only ? "" : folder("infra", "", { repo: true, open: false, end: comp("infra") });
  const mobile = only ? "" : `<prism-tree-item label="mobile" value="mobile" class="cv-dim">${icon("code")}${flag("Off", "is-muted")}</prism-tree-item>`;
  const web = only ? "" : folder("web", [
    folder(".prism", "", { open: false, end: who("Dana Kim") }),
    folder("packages", [
      folder("charts", "", { open: false, end: `${comp("charts", { tip: "Declared only on feature/charts", count: "1 branch" })}${who("Dana Kim")}` }),
      folder("reports", "", { open: false, end: comp("report-ui") }),
      folder("shell", "", { open: false, end: comp("shell") })
    ].join(""))
  ].join(""), { repo: true });
  return `<prism-tree label="Files of every repository" class="cv-tree">${api}${infra}${mobile}${web}</prism-tree>`;
}

// The difference of the deadline slice's version of api/src/retry/strategy.ts from its fork on main, which opens first because its slice comes first in the sidebar.
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
const diffTable = (rows) => `<div class="diff-scroll cv-code"><table class="line-diff"><tbody>${rows.map(([op, a, b, t]) => `<tr class="diff-${op}"><td class="diff-num">${a ?? ""}</td><td class="diff-num">${b ?? ""}</td><td class="diff-text"><span class="diff-mark" aria-hidden="true">${op === "add" ? "+" : op === "del" ? "−" : " "}</span>${esc(t)}</td></tr>`).join("")}</tbody></table></div>`;

const chip = (label, metaText, { pressed = false, start = "", tip = "" } = {}) => `<prism-chip interactive pressed="${pressed}"${tip ? ` tip="${esc(tip)}"` : ""}>${start}${esc(label)}<span slot="meta">${metaText}</span></prism-chip>`;
export function fileView({ picked = false } = {}) {
  const av = (k, n) => `<prism-avatar slot="start" kind="${k}" name="${esc(n)}" size="sm"></prism-avatar>`;
  const counts = (added, removed) => `<span class="cv-add">+${added}</span> <span class="cv-del">−${removed}</span> · verified`;
  return `<div class="cv-file">
    <div class="cv-file-head"><span class="cv-path"><span class="cv-repo">api</span> / src/retry/strategy.ts</span><prism-chip tone="neutral" class="cv-comp"><prism-icon slot="start" name="layers" size="xs" aria-hidden="true"></prism-icon>api</prism-chip></div>
    <div class="cv-versions" role="group" aria-label="Versions of this file">
      ${chip("main", "base", { start: `<prism-icon slot="start" name="check" size="xs"></prism-icon>`, tip: "The file on main" })}
      ${chip("Retry timed-out requests until a deadline", counts(3, 2), { pressed: true, start: av("agent", CLIENT), tip: picked ? `api · claude/retry-deadline, from main · ${CLIENT}` : `api · claude/retry-deadline, from main · api · review/deadline, from main · ${CLIENT}` })}
      ${picked ? "" : chip("Report retry attempts as metrics", counts(4, 3), { start: av("agent", CLIENT), tip: `api · codex/retry-metrics, from main · ${CLIENT}` })}
      ${picked ? "" : chip("Tidy retry limits", counts(1, 1), { start: av("agent", CLIENT), tip: `api · claude/tidy, from main · ${CLIENT}` })}
    </div>
    ${picked ? "" : `<p class="cv-overlap"><prism-icon name="warning" size="xs" aria-hidden="true"></prism-icon><span>Report retry attempts as metrics also changes lines 2–4, so whichever merges second will conflict.</span></p>`}
    ${diffTable(DEADLINE)}
  </div>`;
}

export function page({ picked = false, only = false, mode = "both" } = {}) {
  if (mode === "file") return `<div class="cv-ide cv-one"><section class="cv-view"><prism-button size="sm" variant="ghost" class="cv-back"><prism-icon name="back" size="xs" aria-hidden="true"></prism-icon><span>Files</span></prism-button>${fileView({ picked })}</section></div>`;
  return `<div class="cv-ide${mode === "tree" ? " cv-one" : ""}">
    <aside class="cv-tree-pane">
      <div class="cv-tree-tools">${picked ? `<p class="cv-scope">Showing what <b>Retry timed-out requests until a deadline</b> changes</p>` : ""}<prism-segmented label="Files" value="${only ? "touched" : "all"}"><prism-option value="all"${only ? "" : " selected"}>All files</prism-option><prism-option value="touched"${only ? " selected" : ""}>Touched</prism-option></prism-segmented></div>
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
