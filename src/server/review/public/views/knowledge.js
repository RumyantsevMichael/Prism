import { agoText, exactTime } from "../kit/claim-time.js";
import { artifactLink, bindLinks, emptyState, escapeHtml, pageSub, plural, setPageSub } from "./util.js";

// Knowledge's two entry points: Touched by my work, the records behind the open slice, and Changed this week, the records changed in the last 7 days.

const KINDS = Object.freeze({
  requirement: ["Requirement", "list"],
  decision: ["Decision", "scale"],
  "glossary-term": ["Glossary term", "book"],
  glossary: ["Glossary", "book"],
  diagram: ["Diagram", "diagram"]
});

const STATUS_TONES = { approved: "success", accepted: "success", defined: "neutral", draft: "warning", proposed: "info", superseded: "neutral", deprecated: "neutral", rejected: "danger" };

const GROUPS = Object.freeze({
  cites: ["The contract cites", "from the slice's design"],
  changes: ["This work changes", "planned by the design or changed by the verified result"]
});

export const NO_SLICE = "This page lists the records behind the slice you have open. Open a slice to see them.";

function statusChip(status) {
  if (!status) return "";
  const tone = STATUS_TONES[String(status).toLowerCase().split(/\s/)[0]] ?? "neutral";
  return `<prism-chip tone="${tone}">${escapeHtml(status)}</prism-chip>`;
}

// A record's title links to its page; its kind's icon leads the row and its kind is also said in words.
function titleCell(record, ctx) {
  const [, icon] = KINDS[record.kind] ?? ["", "file"];
  return `<span class="prism-lib-title"><prism-icon class="prism-lib-kind" name="${icon}" size="sm" aria-hidden="true"></prism-icon>${artifactLink(record.ref, ctx, record.title)}</span>`;
}

const kindText = (record) => KINDS[record.kind]?.[0] ?? record.kind;

// The kit's library table: a head row of column names, then rows, and group heads with their count and where the group comes from.
function head(columns) {
  return `<div class="prism-lib-row is-head" aria-hidden="true">${columns.map((column) => `<span>${escapeHtml(column)}</span>`).join("")}</div>`;
}

function groupHead(label, count, source) {
  return `<div class="prism-lib-group"><h2 class="prism-lib-group-name">${escapeHtml(label)} <prism-badge tone="neutral">${count}</prism-badge></h2><span class="prism-lib-group-source">${escapeHtml(source)}</span></div>`;
}

// A quiet cell holds a value in the table's smaller muted text, and a detail cell a still smaller one; a plain cell keeps its content's own look.
const cell = (html, detail = false) => `<span class="prism-lib-cell${detail ? " is-detail" : ""}">${html}</span>`;
const plain = (html) => `<span>${html}</span>`;
const table = (className, html) => `<prism-lib-table class="${className}">${html}</prism-lib-table>`;

/**
 * The records behind one slice, grouped by why they are listed, from `/api/touched` for the slice; `answer` is that response or null without a slice.
 * It answers the line under the page's title as `sub` and the page's body as `body`.
 */
export function renderTouched(answer, inProgress, ctx) {
  if (!answer) {
    const slices = inProgress.length
      ? `<h2 class="knowledge-subhead">In progress</h2><ul class="knowledge-slices">${inProgress.map((entry) => `<li>${artifactLink(`slice:${entry.initiative.id}/${entry.slice.slug}`, ctx, entry.slice.title)}<span class="knowledge-owner">${escapeHtml(entry.initiative.title)}</span></li>`).join("")}</ul>`
      : emptyState("No slice is in progress.");
    return { sub: pageSub(escapeHtml(NO_SLICE)), body: slices };
  }
  const groups = answer.groups.map((group) => {
    const [label, source] = GROUPS[group.reason] ?? [group.reason, ""];
    const rows = group.records.length
      ? group.records.map((record) => `<div class="prism-lib-row">${plain(titleCell(record, ctx))}${cell(escapeHtml(kindText(record)))}${plain(statusChip(record.status))}${cell(escapeHtml(record.why.join("; ")), true)}</div>`).join("")
      : '<p class="prism-lib-nothing">Nothing yet.</p>';
    return `${groupHead(label, group.records.length, source)}${rows}`;
  }).join("");
  const unreadable = answer.verifiedUnreadable ? '<p class="knowledge-note">The verified result could not be read.</p>' : "";
  return {
    sub: pageSub(`Records behind the slice you have open: <b>${escapeHtml(answer.initiative.title)}</b>, slice <b>${escapeHtml(answer.slice.title)}</b>`),
    body: `${table("knowledge-table", `${head(["Title", "Kind", "Status", "Why it is here"])}${groups}`)}${unreadable}`
  };
}

function changedWhen(record) {
  if (record.uncommitted) return '<prism-chip tone="warning">Not committed</prism-chip>';
  if (!Number.isFinite(Date.parse(record.at ?? ""))) return "";
  return `<time datetime="${escapeHtml(record.at)}" tip="${escapeHtml(exactTime(record.at))}">${escapeHtml(agoText(record.at))}</time>`;
}

/** The records changed in the last 7 days, uncommitted first, or why the history cannot tell and which records it could not date, as { sub, body }. */
export function renderChanged(data, ctx) {
  if (!data.available) {
    const undated = data.undated.length
      ? `<h2 class="knowledge-subhead">${escapeHtml(plural(data.undated.length, "record"))} could not be dated</h2>${table("knowledge-table is-undated", `${head(["Title", "Kind"])}${data.undated.map((record) => `<div class="prism-lib-row">${plain(titleCell(record, ctx))}${cell(escapeHtml(kindText(record)))}</div>`).join("")}`)}`
      : "";
    return { sub: pageSub(escapeHtml(`Change history is unavailable: ${data.reason}.`)), body: undated };
  }
  if (!data.records.length) return { sub: pageSub("Records changed in the last 7 days, from the repository's history."), body: emptyState("No record changed in the last 7 days.") };
  return {
    sub: pageSub("Records changed in the last 7 days, from the repository's history, those not committed first."),
    body: table("knowledge-table is-changed", `${head(["Title", "Kind", "Changed", "By"])}${data.records.map((record) => `<div class="prism-lib-row">${plain(titleCell(record, ctx))}${cell(escapeHtml(kindText(record)))}${cell(changedWhen(record))}${cell(escapeHtml(record.author ?? ""))}</div>`).join("")}`)
  };
}

// The page's line goes under its title in the page head, and its body below; a page drawn without a head keeps the line at its top.
function draw(container, { sub, body }, ctx) {
  container.innerHTML = setPageSub(container, sub, ctx) ? body : `${sub}${body}`;
  bindLinks(container, ctx);
}

export async function render(container, entity, ctx) {
  if (entity.kind === "changed") {
    draw(container, renderChanged(entity.data, ctx), ctx);
    return;
  }
  // The page passes the remembered slice's answer with the entity, so a change to the slice's records redraws it; without one the view asks for it.
  const given = entity.touched ?? null;
  const slice = given ? given.slice : ctx.touchedSlice?.() ?? null;
  let answer = given ? given.answer : null;
  if (!given && slice) {
    try {
      answer = await ctx.fetchTouched(slice);
    } catch {
      answer = null;
    }
  }
  draw(container, renderTouched(answer, entity.data?.inProgress ?? [], ctx), ctx);
  ctx.onTouched?.(slice, answer);
}
