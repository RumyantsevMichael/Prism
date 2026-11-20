// Generated from src/server/review/public/views/entities.ts by scripts/native-build/compile.mjs.
import { escapeHtml, status } from "./util.js";
const ENTITY_LABELS = Object.freeze({
  attention: "Attention",
  roadmap: "Roadmap",
  requirements: "Requirements",
  decisions: "Decisions",
  glossary: "Glossary",
  code: "Code",
  agents: "Agents"
});
const SECTIONS = Object.keys(ENTITY_LABELS);
const VIEWS = {
  attention: () => import("./attention.js"),
  roadmap: () => import("./roadmap.js"),
  initiative: () => import("./initiative.js"),
  slice: () => import("./slice.js"),
  requirements: () => import("./library.js"),
  decisions: () => import("./library.js"),
  glossary: () => import("./library.js"),
  code: () => import("./code.js"),
  agents: () => import("./agents.js"),
  diagrams: () => import("./library.js"),
  touched: () => import("./knowledge.js"),
  changed: () => import("./knowledge.js")
};
const KNOWLEDGE_PAGES = Object.freeze({ diagrams: "Diagrams", touched: "Touched by my work", changed: "Changed this week" });
function parseEntityRef(ref) {
  if (SECTIONS.includes(ref)) return { kind: ref };
  if (ref === "launches") return { kind: "agents" };
  const group = /^agents:(needs-you|this-computer|other|expired)$/.exec(ref ?? "");
  if (group) return { kind: "agents", page: group[1] };
  let match = /^attention:(questions|findings|failed|blocked|ready|problems|answered|roadmap-questions|work\/[A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "attention", page: match[1] };
  match = /^knowledge:(diagrams|touched|changed)$/.exec(ref ?? "");
  if (match) return { kind: "knowledge", page: match[1] };
  match = /^initiative:([A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "initiative", id: match[1] };
  match = /^slice:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "slice", id: match[1], slug: match[2] };
  return null;
}
const RECORD_KINDS = [
  [/(^|\/)change-map\.json$/i, "Change map"],
  [/(^|\/)review\.json$/i, "Review ledger"],
  [/(^|\/)state\.json$/i, "Coordination state"],
  [/(^|\/)initiative\.json$/i, "Initiative record"],
  [/(^|\/)roadmap\.(json|md)$/i, "Roadmap"],
  [/\/claims\/[^/]+\.json$/i, "Claim"],
  [/\/runs\/[^/]+\.json$/i, "Verification run"],
  [/(^|\/)slice\.md$/i, "Design"],
  [/(^|\/)initiative\.md$/i, "Initiative summary"],
  [/(^|\/)review\.md$/i, "Review summary"],
  [/(^|\/)workflow\.md$/i, "Workflow settings"],
  [/(^|\/)glossary\.md$/i, "Glossary"],
  [/\.puml$/i, "Diagram"],
  [/\.json$/i, "Record"],
  [/\.md$/i, "Document"]
];
const NAMED_BY_KIND = /* @__PURE__ */ new Set(["Roadmap", "Glossary", "Workflow settings"]);
function recordKind(path) {
  return RECORD_KINDS.find(([pattern]) => pattern.test(String(path ?? "")))?.[1] ?? null;
}
function humanize(name) {
  const words = name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}
function recordLabel(path, titles = /* @__PURE__ */ new Map()) {
  const kind = recordKind(path) ?? "File";
  const segments = String(path).split("/");
  const name = segments.at(-1);
  const folders = segments.slice(0, -1);
  let initiative = null;
  let owner = null;
  folders.forEach((segment, index) => {
    if (titles.has(`initiative:${segment}`)) {
      initiative = segment;
      owner ??= titles.get(`initiative:${segment}`);
    } else if (initiative && titles.has(`slice:${initiative}/${segment}`) && folders[index - 1] !== "claims") owner = titles.get(`slice:${initiative}/${segment}`);
  });
  if (initiative && folders.at(-1) === "claims") owner = titles.get(`slice:${initiative}/${name.replace(/\.json$/i, "")}`) ?? owner;
  const label = NAMED_BY_KIND.has(kind) ? kind : owner ?? humanize(name);
  return { label, kind, owner };
}
function entityLabel(entity) {
  const data = entity.data;
  if (entity.kind === "attention" && entity.ref !== "attention") return { title: "Attention", lead: null, subtitle: null };
  if (entity.kind === "attention") return { title: "Attention", lead: "Answer here or in the agent's conversation; the agent picks the answer up on its own.", subtitle: null };
  if (entity.kind === "roadmap") return { eyebrow: "Roadmap", title: "Roadmap", lead: data.serves || null, subtitle: data.recordPath ?? null };
  if (entity.kind === "initiative") return { eyebrow: "Initiative", title: data.roadmapItem?.title ?? data.id, subtitle: data.recordPath };
  if (entity.kind === "slice") return { eyebrow: `Slice \xB7 ${data.initiativeTitle}`, title: data.slice.title, subtitle: data.artifacts?.folder ?? null };
  if (entity.kind === "agents") return { title: ENTITY_LABELS.agents, lead: "Every agent working on this workspace, and every session launched on this computer.", subtitle: null };
  if (entity.kind === "glossary") return { eyebrow: "Library", title: "Glossary", subtitle: data.path };
  if (entity.kind === "code") return { eyebrow: "Library", title: "Code", subtitle: null };
  if (Object.hasOwn(KNOWLEDGE_PAGES, entity.kind)) return { eyebrow: "Knowledge", title: KNOWLEDGE_PAGES[entity.kind], subtitle: null };
  return { eyebrow: "Library", title: ENTITY_LABELS[entity.kind], subtitle: data.directory };
}
async function renderEntity(container, entity, ctx) {
  try {
    const view = await VIEWS[entity.kind]();
    await view.render(container, entity, ctx);
  } catch (error) {
    container.innerHTML = `<prism-panel class="view-section"><p class="error">The ${escapeHtml(entity.kind)} view failed: ${escapeHtml(error.message)}</p></prism-panel>`;
  }
}
function stateBadge(state) {
  return status(state);
}
function progressBar(progress) {
  if (!progress || !progress.leaves) return "";
  const segments = ["done", "in-progress", "blocked", "deferred"].map((status2) => {
    const share = progress[status2] / progress.leaves * 100;
    return share ? `<span class="progress-segment segment-${status2}" data-width="${share}"></span>` : "";
  }).join("");
  const counts = ["done", "in-progress", "blocked", "deferred"].filter((status2) => progress[status2]).map((status2) => `${progress[status2]} ${status2.replace("-", " ")}`);
  const rest = progress.leaves - ["done", "in-progress", "blocked", "deferred"].reduce((sum, status2) => sum + (progress[status2] ?? 0), 0);
  if (rest > 0) counts.push(`${rest} not started`);
  return `<div class="progress" role="img" aria-label="${progress.done} of ${progress.leaves} slices done" tip="${escapeHtml(counts.join(" \xB7 "))}"><div class="progress-track">${segments}</div><span class="progress-label">${progress.done} of ${progress.leaves} done</span></div>`;
}
function applyWidths(root) {
  for (const element of root.querySelectorAll("[data-width]")) {
    element.style.width = `${Math.max(0, Math.min(100, Number(element.dataset.width)))}%`;
  }
}
export {
  ENTITY_LABELS,
  KNOWLEDGE_PAGES,
  applyWidths,
  entityLabel,
  parseEntityRef,
  progressBar,
  recordKind,
  recordLabel,
  renderEntity,
  stateBadge
};
