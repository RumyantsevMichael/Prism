import { badge, escapeHtml } from "./util.js";

export const ENTITY_LABELS = Object.freeze({
  attention: "Attention",
  roadmap: "Roadmap",
  requirements: "Requirements",
  decisions: "Decisions",
  glossary: "Glossary"
});

const SECTIONS = Object.keys(ENTITY_LABELS);
const VIEWS = {
  attention: () => import("./attention.js"),
  roadmap: () => import("./roadmap.js"),
  initiative: () => import("./initiative.js"),
  slice: () => import("./slice.js"),
  requirements: () => import("./library.js"),
  decisions: () => import("./library.js"),
  glossary: () => import("./library.js")
};

// Mirrors the server's entity references: sections, initiative:<id>, and slice:<id>/<slug>.
export function parseEntityRef(ref) {
  if (SECTIONS.includes(ref)) return { kind: ref };
  let match = /^initiative:([A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "initiative", id: match[1] };
  match = /^slice:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "slice", id: match[1], slug: match[2] };
  return null;
}

// Prism's own records by kind, matched on their path; a record's name is its kind and the title of the initiative or slice that owns it, never its file name.
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
const NAMED_BY_KIND = new Set(["Roadmap", "Glossary", "Workflow settings"]);

/** The kind of one of Prism's records or documents at `path`, such as Design, Diagram, or Change map, or null for another file. */
export function recordKind(path) {
  return RECORD_KINDS.find(([pattern]) => pattern.test(String(path ?? "")))?.[1] ?? null;
}

function humanize(name) {
  const words = name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/**
 * Names a record or document by title and kind: { label, kind, owner }, where the label is the title of the slice or initiative whose folder holds it,
 * or the document's own name in words, and `titles` maps initiative:<id> and slice:<id>/<slug> references to titles.
 */
export function recordLabel(path, titles = new Map()) {
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
  // A claim names its slice in its file name.
  if (initiative && folders.at(-1) === "claims") owner = titles.get(`slice:${initiative}/${name.replace(/\.json$/i, "")}`) ?? owner;
  const label = NAMED_BY_KIND.has(kind) ? kind : owner ?? humanize(name);
  return { label, kind, owner };
}

export function entityLabel(entity) {
  const data = entity.data;
  if (entity.kind === "attention") return { title: "Attention", lead: "Answer here or in the agent's conversation; the agent picks the answer up on its own.", subtitle: null };
  if (entity.kind === "roadmap") return { eyebrow: "Roadmap", title: "Roadmap", lead: data.serves || null, subtitle: data.recordPath ?? null };
  if (entity.kind === "initiative") return { eyebrow: "Initiative", title: data.roadmapItem?.title ?? data.id, subtitle: data.recordPath };
  if (entity.kind === "slice") return { eyebrow: `Slice · ${data.initiativeTitle}`, title: data.slice.title, subtitle: data.artifacts?.folder ?? null };
  if (entity.kind === "glossary") return { eyebrow: "Library", title: "Glossary", subtitle: data.path };
  return { eyebrow: "Library", title: ENTITY_LABELS[entity.kind], subtitle: data.directory };
}

export async function renderEntity(container, entity, ctx) {
  try {
    const view = await VIEWS[entity.kind]();
    await view.render(container, entity, ctx);
  } catch (error) {
    container.innerHTML = `<prism-panel class="view-section"><p class="error">The ${escapeHtml(entity.kind)} view failed: ${escapeHtml(error.message)}</p></prism-panel>`;
  }
}

const STATE_TONES = { envisioned: "neutral", planned: "info", "in-progress": "accent", shipped: "success", superseded: "neutral", unlisted: "warning" };

/** A roadmap state as a kit status badge, toned by the state. */
export function stateBadge(state) {
  return badge(state, STATE_TONES[state] ?? "neutral");
}

export function progressBar(progress) {
  if (!progress || !progress.leaves) return "";
  const segments = ["done", "in-progress", "blocked", "deferred"].map((status) => {
    const share = (progress[status] / progress.leaves) * 100;
    return share ? `<span class="progress-segment segment-${status}" data-width="${share}"></span>` : "";
  }).join("");
  // Each segment's count is the bar's tooltip, as the label names only the done ones.
  const counts = ["done", "in-progress", "blocked", "deferred"].filter((status) => progress[status]).map((status) => `${progress[status]} ${status.replace("-", " ")}`);
  const rest = progress.leaves - ["done", "in-progress", "blocked", "deferred"].reduce((sum, status) => sum + (progress[status] ?? 0), 0);
  if (rest > 0) counts.push(`${rest} not started`);
  return `<div class="progress" role="img" aria-label="${progress.done} of ${progress.leaves} slices done" tip="${escapeHtml(counts.join(" · "))}"><div class="progress-track">${segments}</div><span class="progress-label">${progress.done} of ${progress.leaves} done</span></div>`;
}

export function applyWidths(root) {
  for (const element of root.querySelectorAll("[data-width]")) {
    element.style.width = `${Math.max(0, Math.min(100, Number(element.dataset.width)))}%`;
  }
}
