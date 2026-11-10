import { agoText, exactTime } from "../kit/claim-time.js";
import { artifactLink, bindLinks, escapeHtml, plural } from "./util.js";

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
  return `<span class="knowledge-title"><prism-icon class="knowledge-kind" name="${icon}" size="sm" aria-hidden="true"></prism-icon>${artifactLink(record.ref, ctx, record.title)}</span>`;
}

const kindText = (record) => KINDS[record.kind]?.[0] ?? record.kind;

function head(columns) {
  return `<div class="knowledge-row is-head" aria-hidden="true">${columns.map((column) => `<span class="label-caps">${escapeHtml(column)}</span>`).join("")}</div>`;
}

function groupHead(label, count, source) {
  return `<div class="knowledge-group"><h2 class="knowledge-group-name">${escapeHtml(label)} <prism-badge tone="neutral">${count}</prism-badge></h2><span class="knowledge-group-source">${escapeHtml(source)}</span></div>`;
}

const lead = (html) => `<p class="knowledge-lead">${html}</p>`;

/** The records behind one slice, grouped by why they are listed, from `/api/touched` for the slice; `answer` is that response or null without a slice. */
export function renderTouched(answer, inProgress, ctx) {
  if (!answer) {
    const slices = inProgress.length
      ? `<ul class="knowledge-slices">${inProgress.map((entry) => `<li>${artifactLink(`slice:${entry.initiative.id}/${entry.slice.slug}`, ctx, entry.slice.title)}<span class="knowledge-owner">${escapeHtml(entry.initiative.title)}</span></li>`).join("")}</ul>`
      : '<p class="knowledge-note">No slice is in progress.</p>';
    return `${lead(escapeHtml(NO_SLICE))}${inProgress.length ? '<h2 class="knowledge-subhead">In progress</h2>' : ""}${slices}`;
  }
  const groups = answer.groups.map((group) => {
    const [label, source] = GROUPS[group.reason] ?? [group.reason, ""];
    const rows = group.records.length
      ? group.records.map((record) => `<div class="knowledge-row">
        <span>${titleCell(record, ctx)}</span>
        <span class="knowledge-cell">${escapeHtml(kindText(record))}</span>
        <span>${statusChip(record.status)}</span>
        <span class="knowledge-why">${escapeHtml(record.why.join("; "))}</span>
      </div>`).join("")
      : '<p class="knowledge-nothing">Nothing yet.</p>';
    return `${groupHead(label, group.records.length, source)}${rows}`;
  }).join("");
  const unreadable = answer.verifiedUnreadable ? '<p class="knowledge-note">The verified result could not be read.</p>' : "";
  return `${lead(`<span>Records behind the slice you have open: <b>${escapeHtml(answer.initiative.title)}</b>, slice <b>${escapeHtml(answer.slice.title)}</b></span>`)}
    <div class="knowledge-table">${head(["Title", "Kind", "Status", "Why it is here"])}${groups}</div>${unreadable}`;
}

function changedWhen(record) {
  if (record.uncommitted) return '<prism-chip tone="warning">Not committed</prism-chip>';
  if (!Number.isFinite(Date.parse(record.at ?? ""))) return "";
  return `<time datetime="${escapeHtml(record.at)}" tip="${escapeHtml(exactTime(record.at))}">${escapeHtml(agoText(record.at))}</time>`;
}

/** The records changed in the last 7 days, uncommitted first, or why the history cannot tell and which records it could not date. */
export function renderChanged(data, ctx) {
  if (!data.available) {
    const undated = data.undated.length
      ? `<h2 class="knowledge-subhead">${escapeHtml(plural(data.undated.length, "record"))} could not be dated</h2><div class="knowledge-table is-undated">${head(["Title", "Kind"])}${data.undated.map((record) => `<div class="knowledge-row"><span>${titleCell(record, ctx)}</span><span class="knowledge-cell">${escapeHtml(kindText(record))}</span></div>`).join("")}</div>`
      : "";
    return `${lead(escapeHtml(`Change history is unavailable: ${data.reason}.`))}${undated}`;
  }
  if (!data.records.length) return `${lead("Records changed in the last 7 days, from the repository's history.")}<p class="knowledge-note">No record changed in the last 7 days.</p>`;
  return `${lead("Records changed in the last 7 days, from the repository's history, those not committed first.")}
    <div class="knowledge-table is-changed">${head(["Title", "Kind", "Changed", "By"])}${data.records.map((record) => `<div class="knowledge-row">
      <span>${titleCell(record, ctx)}</span>
      <span class="knowledge-cell">${escapeHtml(kindText(record))}</span>
      <span class="knowledge-cell">${changedWhen(record)}</span>
      <span class="knowledge-cell">${escapeHtml(record.author ?? "")}</span>
    </div>`).join("")}</div>`;
}

export async function render(container, entity, ctx) {
  if (entity.kind === "changed") {
    container.innerHTML = renderChanged(entity.data, ctx);
    bindLinks(container, ctx);
    return;
  }
  const slice = ctx.touchedSlice?.() ?? null;
  let answer = null;
  if (slice) {
    try {
      answer = await ctx.fetchTouched(slice);
    } catch {
      answer = null;
    }
  }
  container.innerHTML = renderTouched(answer, entity.data?.inProgress ?? [], ctx);
  ctx.onTouched?.(slice, answer);
  bindLinks(container, ctx);
}
