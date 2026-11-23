import { escapeHtml, status } from "./util.js";

export const ENTITY_LABELS: Readonly<Record<string, any>> = Object.freeze({
  attention: "Attention",
  roadmap: "Roadmap",
  requirements: "Requirements",
  decisions: "Decisions",
  glossary: "Glossary",
  code: "Code",
  agents: "Agents"
});

const SECTIONS = Object.keys(ENTITY_LABELS);
const VIEWS: Record<string, any> = {
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
  changed: () => import("./knowledge.js"),
  "migration-run": () => import("./format-migration.js")
};

// Knowledge's own pages by the part of their address after `knowledge:`.
export const KNOWLEDGE_PAGES: Readonly<Record<string, any>> = Object.freeze({ diagrams: "Diagrams", touched: "Touched by my work", changed: "Changed this week" });

// Mirrors the server's entity references: sections, Attention's filtered pages, Knowledge's pages, initiative:<id>, slice:<id>/<slug>, and migration-run:<run id>.
export function parseEntityRef(ref: any) {
  if (SECTIONS.includes(ref)) return { kind: ref };
  // The Launched sessions address, as a restored tab or an old link, opens the Agents page that replaced it; agents:<group> opens it with that Show choice made.
  if (ref === "launches") return { kind: "agents" };
  const group = /^agents:(needs-you|this-computer|other|expired|archived)$/.exec(ref ?? "");
  if (group) return { kind: "agents", page: group[1] };
  // Attention's filtered pages: one kind, one initiative's items, the roadmap's open questions, or the questions answered this week.
  let match = /^attention:(questions|findings|failed|blocked|ready|problems|formats|answered|roadmap-questions|work\/[A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "attention", page: match[1] };
  // Knowledge's own pages: the diagrams, the records behind the open slice, and this week's record changes.
  match = /^knowledge:(diagrams|touched|changed)$/.exec(ref ?? "");
  if (match) return { kind: "knowledge", page: match[1] };
  match = /^initiative:([A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "initiative", id: match[1] };
  match = /^slice:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "slice", id: match[1], slug: match[2] };
  // A format migration run's page.
  match = /^migration-run:(run-[0-9a-f]{16})$/.exec(ref ?? "");
  if (match) return { kind: "migration-run", id: match[1] };
  return null;
}

// Prism's own records by kind, matched on their path; a record's name is its kind and the title of the initiative or slice that owns it, never its file name.
const RECORD_KINDS: [RegExp, any][] = [
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
export function recordKind(path: any) {
  return RECORD_KINDS.find(([pattern]) => pattern.test(String(path ?? "")))?.[1] ?? null;
}

function humanize(name: string) {
  const words = name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/**
 * Names a record or document by title and kind: { label, kind, owner }, where the label is the title of the slice or initiative whose folder holds it,
 * or the document's own name in words, and `titles` maps initiative:<id> and slice:<id>/<slug> references to titles.
 */
export function recordLabel(path: any, titles = new Map()) {
  const kind = recordKind(path) ?? "File";
  const segments = String(path).split("/");
  const name = segments.at(-1);
  const folders = segments.slice(0, -1);
  let initiative: any = null;
  let owner = null;
  folders.forEach((segment, index) => {
    if (titles.has(`initiative:${segment}`)) {
      initiative = segment;
      owner ??= titles.get(`initiative:${segment}`);
    } else if (initiative && titles.has(`slice:${initiative}/${segment}`) && folders[index - 1] !== "claims") owner = titles.get(`slice:${initiative}/${segment}`);
  });
  // A claim names its slice in its file name.
  if (initiative && folders.at(-1) === "claims") owner = titles.get(`slice:${initiative}/${name!.replace(/\.json$/i, "")}`) ?? owner;
  const label = NAMED_BY_KIND.has((kind as any)) ? kind : owner ?? humanize((name as any));
  return { label, kind, owner };
}

export function entityLabel(entity: any) {
  const data = entity.data;
  if (entity.kind === "attention" && entity.ref !== "attention") return { title: "Attention", lead: null, subtitle: null };
  if (entity.kind === "attention") return { title: "Attention", lead: "Answer here or in the agent's conversation; the agent picks the answer up on its own.", subtitle: null };
  if (entity.kind === "roadmap") return { eyebrow: "Roadmap", title: "Roadmap", lead: data.serves || null, subtitle: data.recordPath ?? null };
  if (entity.kind === "initiative") return { eyebrow: "Initiative", title: data.roadmapItem?.title ?? data.id, subtitle: data.recordPath };
  if (entity.kind === "slice") return { eyebrow: `Slice · ${data.initiativeTitle}`, title: data.slice.title, subtitle: data.artifacts?.folder ?? null };
  if (entity.kind === "migration-run") return { eyebrow: "Format migration", title: `${data.title} ${data.scope?.label ? `in scope ${data.scope.label}` : "in this checkout"}`, lead: null, subtitle: null };
  if (entity.kind === "agents") return { title: ENTITY_LABELS.agents, lead: "Every agent working on this workspace, and every session launched on this computer.", subtitle: null };
  if (entity.kind === "glossary") return { eyebrow: "Library", title: "Glossary", subtitle: data.path };
  if (entity.kind === "code") return { eyebrow: "Library", title: "Code", subtitle: null };
  if (Object.hasOwn(KNOWLEDGE_PAGES, entity.kind)) return { eyebrow: "Knowledge", title: KNOWLEDGE_PAGES[entity.kind], subtitle: null };
  return { eyebrow: "Library", title: ENTITY_LABELS[entity.kind], subtitle: data.directory };
}

export async function renderEntity(container: any, entity: any, ctx: any) {
  try {
    const view = await VIEWS[entity.kind]();
    await view.render(container, entity, ctx);
  } catch (error) {
    container.innerHTML = `<prism-panel class="view-section"><p class="error">The ${escapeHtml(entity.kind)} view failed: ${escapeHtml(error.message)}</p></prism-panel>`;
  }
}

/** A roadmap state as a kit prism-status. */
export function stateBadge(state: any) {
  return status(state);
}

export function progressBar(progress: any) {
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

export function applyWidths(root: any) {
  for (const element of root.querySelectorAll("[data-width]")) {
    element.style.width = `${Math.max(0, Math.min(100, Number(element.dataset.width)))}%`;
  }
}
