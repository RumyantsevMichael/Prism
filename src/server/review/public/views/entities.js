import { escapeHtml } from "./util.js";

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

export function entityLabel(entity) {
  const data = entity.data;
  if (entity.kind === "attention") return { title: "What needs you", subtitle: null };
  if (entity.kind === "roadmap") return { eyebrow: "Roadmap", title: data.serves || "Roadmap", subtitle: data.recordPath ?? null };
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
    container.innerHTML = `<section class="view-card"><p class="error">The ${escapeHtml(entity.kind)} view failed: ${escapeHtml(error.message)}</p></section>`;
  }
}

export function stateBadge(state) {
  return `<span class="state-badge state-${escapeHtml(state)}">${escapeHtml(state)}</span>`;
}

export function progressBar(progress) {
  if (!progress || !progress.leaves) return "";
  const segments = ["done", "in-progress", "blocked", "deferred"].map((status) => {
    const share = (progress[status] / progress.leaves) * 100;
    return share ? `<span class="progress-segment segment-${status}" data-width="${share}" title="${progress[status]} ${status}"></span>` : "";
  }).join("");
  return `<div class="progress" role="img" aria-label="${progress.done} of ${progress.leaves} slices done"><div class="progress-track">${segments}</div><span class="progress-label">${progress.done} of ${progress.leaves} done</span></div>`;
}

export function applyWidths(root) {
  for (const element of root.querySelectorAll("[data-width]")) {
    element.style.width = `${Math.max(0, Math.min(100, Number(element.dataset.width)))}%`;
  }
}
