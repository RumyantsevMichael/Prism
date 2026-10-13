import { artifactChip, bindLinks, card, emptyNote, escapeHtml, plural } from "./util.js";

const GATE_LABELS = {
  "visual-review": "Visual review",
  correctness: "Correctness confirmation",
  decision: "Decision",
  assistance: "Action needed"
};

function ago(timestamp) {
  const elapsed = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.max(0, Math.round(elapsed / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function location(item, ctx) {
  const parts = [];
  if (item.initiative) parts.push(artifactChip(`initiative:${item.initiative.id}`, ctx, item.initiative.title));
  if (item.slice) parts.push(artifactChip(`slice:${item.initiative.id}/${item.slice.slug}`, ctx, item.slice.title));
  return parts.join('<span class="crumb-separator" aria-hidden="true">›</span>');
}

function gateCard(item, ctx) {
  const available = item.artifacts.filter((artifact) => artifact.available);
  const missing = item.artifacts.filter((artifact) => !artifact.available);
  return `<li class="attention-card gate-${escapeHtml(item.kind)}">
    <div class="attention-head"><span class="gate-kind">${escapeHtml(GATE_LABELS[item.kind] ?? item.kind)}</span><span class="attention-where">${location(item, ctx)}</span><span class="muted" title="${escapeHtml(item.askedAt)}">${escapeHtml(ago(item.askedAt))}</span></div>
    <p class="attention-question">${escapeHtml(item.question)}</p>
    ${available.length ? `<div class="attention-artifacts"><span class="muted">Inspect</span> ${available.map((artifact) => artifactChip(artifact.path, ctx, artifact.path.split("/").pop())).join(" ")}</div>` : ""}
    ${missing.length ? `<p class="muted">Not found: ${missing.map((artifact) => `<code>${escapeHtml(artifact.path)}</code>`).join(" ")}</p>` : ""}
  </li>`;
}

function noteCard(item, ctx) {
  const roadmapLink = artifactChip("roadmap", ctx, "Roadmap");
  const describe = {
    "pending-note": () => ["Pending item", escapeHtml(item.text), location(item, ctx)],
    unlisted: () => ["Needs prioritization", `${escapeHtml(item.initiative.id)} has an initiative record but no roadmap entry. Ask the agent to run <code>roadmap</code>.`, location(item, ctx)],
    "open-question": () => ["Roadmap question", escapeHtml(item.text), roadmapLink],
    "roadmap-missing": () => ["No roadmap", `No roadmap record exists at <code>${escapeHtml(item.path)}</code>. Ask the agent to run <code>roadmap</code> or <code>workflow-init</code>.`, ""],
    "roadmap-problem": () => ["Roadmap problem", escapeHtml(item.message), roadmapLink],
    config: () => ["Workflow config", escapeHtml(item.message), "<code>.prism/workflow.md</code>"]
  }[item.type];
  const content = describe ? describe() : [item.type, "", ""];
  return `<li class="attention-card note-${escapeHtml(item.type)}">
    <div class="attention-head"><span class="gate-kind is-note">${escapeHtml(content[0])}</span><span class="attention-where">${content[2]}</span></div>
    <p class="attention-question">${content[1]}</p>
  </li>`;
}

function watchRow(item, ctx) {
  const where = location(item, ctx);
  const describe = {
    blocked: () => ['<span class="status-pill is-bad">blocked</span>', "The slice is blocked."],
    findings: () => [item.blocking ? `<span class="status-pill is-bad">${plural(item.blocking, "blocking finding")}</span>` : `<span class="status-pill is-warn">${plural(item.unresolved, "open finding")}</span>`, artifactChip(item.path, ctx, "Open the findings board")],
    active: () => ['<span class="status-pill is-info">active</span>', `${escapeHtml(item.activity)}${item.label ? ` · ${escapeHtml(item.label)}` : ""} · ${escapeHtml(item.workers.join(", "))}`],
    "ready-to-ship": () => ['<span class="status-pill is-good">ready to ship</span>', "Every slice is done; the orchestrator records the ship decision at graduation."],
    "record-problem": () => ['<span class="status-pill is-bad">record problem</span>', `${artifactChip(item.path, ctx, item.path.split("/").pop())} ${escapeHtml(item.message)}`]
  }[item.type];
  const row = describe ? describe() : [escapeHtml(item.type), ""];
  return `<tr><td>${row[0]}</td><td class="attention-where">${where}</td><td>${row[1]}</td></tr>`;
}

export function render(container, entity, ctx) {
  const data = entity.data;
  const gates = data.needsYou.filter((item) => item.type === "gate");
  const notes = data.needsYou.filter((item) => item.type !== "gate");
  container.innerHTML = `
    <section class="view-card summary-card">
      <div class="stat-row">
        <div class="stat ${gates.length ? "is-warn" : "is-good"}"><span class="stat-value">${gates.length}</span><span class="stat-label">${gates.length === 1 ? "question waits" : "questions wait"} on you</span></div>
        <div class="stat"><span class="stat-value">${notes.length}</span><span class="stat-label">other ${notes.length === 1 ? "item needs" : "items need"} you</span></div>
        <div class="stat"><span class="stat-value">${data.watch.length}</span><span class="stat-label">agent-side ${data.watch.length === 1 ? "signal" : "signals"}</span></div>
      </div>
    </section>
    ${card("Needs you", data.needsYou.length
      ? `<ul class="attention-list">${gates.map((item) => gateCard(item, ctx)).join("")}${notes.map((item) => noteCard(item, ctx)).join("")}</ul>`
      : emptyNote("Nothing is waiting on you."), { eyebrow: "Answer in the agent conversation" })}
    <p class="attention-footnote muted">The orchestrator records a question here while it waits on you during an orchestrated run. Direct skill runs, such as ideate or roadmap, still ask only in the conversation.</p>
    ${card("Watch", data.watch.length
      ? `<div class="table-wrap"><table class="data-table attention-watch"><tbody>${data.watch.map((item) => watchRow(item, ctx)).join("")}</tbody></table></div>`
      : emptyNote("No blocked slices, open findings, or active work."), { eyebrow: "Agent-side state" })}`;
  bindLinks(container, ctx);
}
