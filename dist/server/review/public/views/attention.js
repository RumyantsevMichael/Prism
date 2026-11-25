// Generated from src/server/review/public/views/attention.ts by scripts/native-build/compile.mjs.
import { artifactChip, artifactLink, badge, bindLinks, chip, emptyState, escapeHtml, keyValues, messageHtml, pageSub, plural, setPageSub, stat } from "./util.js";
import { recordKind, recordLabel } from "./entities.js";
import { claimAttributes } from "./claims.js";
import { isExpired } from "./claim-index.js";
import { notifyControl } from "./attention-signal.js";
import { currentPhase } from "./slice.js";
import { timeLeft } from "../kit/claim-time.js";
import { findingsList, formatBadge } from "./format-marks.js";
import { POINT_KINDS, rerunRun, scopeWords, whereChip } from "./format-migration.js";
import { createActionList } from "./actions.js";
const GATE_LABELS = {
  "visual-review": "Visual review",
  correctness: "Correctness confirmation",
  decision: "Decision",
  assistance: "Action needed",
  approval: "Approval"
};
const KIND_LOOK = {
  "visual-review": { icon: "gate", tone: "accent", chip: "eye" },
  correctness: { icon: "gate", tone: "accent", chip: "check-circle" },
  decision: { icon: "question", tone: "info", chip: "question" },
  assistance: { icon: "warning", tone: "warning", chip: "warning" },
  approval: { icon: "gate", tone: "accent", chip: "check-circle" }
};
function liveTime(time, { format = "ago", className = "", slot = "" } = {}) {
  if (!time) return "";
  return `<prism-time${className ? ` class="${className}"` : ""}${slot ? ` slot="${slot}"` : ""}${format === "ago" ? "" : ` format="${format}"`} datetime="${escapeHtml(time)}"></prism-time>`;
}
const shortTime = (time) => liveTime(time, { format: "short" });
function location(item, ctx) {
  if (item.kind === "approval" && item.artifact) return artifactChip(item.artifact.path, ctx, item.artifact.path.split("/").pop());
  const parts = [];
  if (item.initiative) parts.push(artifactChip(`initiative:${item.initiative.id}`, ctx, item.initiative.title));
  if (item.slice) parts.push(artifactChip(`slice:${item.initiative.id}/${item.slice.slug}`, ctx, item.slice.title));
  return parts.join('<span class="crumb-separator" aria-hidden="true">\u203A</span>');
}
const REVIEW_KINDS = /* @__PURE__ */ new Set(["visual-review", "correctness", "approval"]);
function choices(item) {
  if (REVIEW_KINDS.has(item.kind)) return [["approve", "Approve"], ["request-changes", "Request changes"]];
  if (item.kind === "assistance") return [];
  return (item.options ?? []).map((option) => [option.id, option.label]);
}
function choiceLabel(item, choice) {
  if (item.kind === "assistance" && choice === "done") return "Done";
  return choices(item).find(([id]) => id === choice)?.[1] ?? (choice ? choice : "Free answer");
}
const NO_RESULT_PLACEHOLDER = "Answer the run's question, or say what it should do next";
function answerState(item, draft = {}) {
  const options = choices(item);
  const choice = item.kind === "assistance" ? "done" : options.some(([id]) => id === draft.choice) ? draft.choice : null;
  const hasNote = typeof draft.note === "string" && draft.note.trim() !== "";
  const optional = { noteRequired: false, noteLabel: "Note", notePlaceholder: "Anything the agent should know" };
  if (REVIEW_KINDS.has(item.kind)) {
    if (choice === "request-changes") {
      return { choice, ready: hasNote, noteRequired: true, noteLabel: "What should change", notePlaceholder: "Describe what to change; the agent revises from this note", submitLabel: "Request changes", hint: hasNote ? "" : "Write what should change to send this." };
    }
    if (choice === "approve") return { choice, ready: true, ...optional, submitLabel: "Approve", hint: "" };
    return { choice, ready: false, ...optional, notePlaceholder: "Anything the agent should know; required if you request changes", submitLabel: "Send answer", hint: hasNote ? "Pick Approve or Request changes to send your note." : "Pick Approve or Request changes." };
  }
  if (item.kind === "assistance" && item.launch) return { choice, ready: true, ...optional, noteLabel: "Your answer", notePlaceholder: NO_RESULT_PLACEHOLDER, submitLabel: "Answer and resume", hint: "" };
  if (item.kind === "assistance") return { choice, ready: true, ...optional, submitLabel: "Mark as done", hint: "" };
  if (options.length) {
    return { choice, ready: Boolean(choice) || hasNote, ...optional, notePlaceholder: "Add a note, or answer in your own words without picking an option", submitLabel: "Send answer", hint: choice || hasNote ? "" : "Pick an option or write your answer." };
  }
  return { choice, ready: hasNote, noteRequired: true, noteLabel: "Your answer", notePlaceholder: "Answer in your own words", submitLabel: "Send answer", hint: hasNote ? "" : "Write your answer to send it." };
}
function noteLabel(state) {
  const label = state.noteLabel === "Note" ? "Note for the agent" : state.noteLabel;
  return `${label} \xB7 ${state.noteRequired ? "required" : "optional"}`;
}
function readyText(item, words, ready, fallback) {
  if (!ready) return words.hint || fallback;
  return liveHolder(item) ? `Ready to send. ${item.claim.label} resumes shortly after.` : "Ready to send.";
}
function when(time, className = "attention-time") {
  return liveTime(time, { className });
}
function liveHolder(item) {
  const claim = item.claim;
  return claim && typeof claim.label === "string" && !isExpired(claim) ? claim : null;
}
const PHASES = [["requirements", "Requirements"], ["design", "Design"], ["frozen", "Frozen"], ["build", "Build"], ["review", "Review"], ["shipped", "Shipped"]];
const PHASE_GATES = { requirements: "Requirements gate", design: "Design gate", frozen: "Design gate \xB7 tests frozen", build: "Build gate", review: "Review gate", shipped: "Ship gate" };
function gatePhase(item) {
  const facts = item.phase;
  if (!facts?.status) return null;
  return currentPhase({ status: facts.status, design: facts.designed ? { review: facts.review } : null });
}
function kindChip(item) {
  const look = KIND_LOOK[item.kind];
  return chip(`${look ? `<prism-icon name="${look.chip}" size="xs"></prism-icon> ` : ""}${escapeHtml(GATE_LABELS[item.kind] ?? item.kind)}`);
}
const PHASE_KINDS = /* @__PURE__ */ new Set(["visual-review", "correctness"]);
function gateHead(item, ctx, time) {
  const phase = PHASE_KINDS.has(item.kind) ? gatePhase(item) : null;
  const tag = phase !== null && phase < PHASES.length ? `<prism-phase variant="tag" phase="${PHASES[phase][0]}">${escapeHtml(PHASE_GATES[PHASES[phase][0]])}</prism-phase>` : "";
  return `<div class="gate-chips">${kindChip(item)}${tag}${when(time, "attention-time gate-time")}</div>
    <h3 class="gate-question">${escapeHtml(item.question)}</h3>
    ${item.kind === "approval" ? servedWork(item, ctx) : gateWork(item, ctx)}`;
}
function workRow(initiative, slice, phase, extra = "") {
  const tag = phase !== null && phase < PHASES.length ? `<prism-phase slot="kind" phase="${PHASES[phase][0]}">${escapeHtml(PHASES[phase][1])}</prism-phase>` : "";
  const row = slice ? `<prism-row wrap${tag ? " stack" : ""} icon="layers" tone="accent">${slice}<span slot="description">Slice of ${initiative}</span>${tag}</prism-row>` : `<prism-row wrap icon="roadmap" tone="neutral">${initiative}<span slot="description">Initiative</span></prism-row>`;
  return `<div class="prism-rows gate-work${extra}" role="list" aria-label="Work">${row}</div>`;
}
function gateWork(item, ctx) {
  if (!item.initiative) return "";
  const initiative = artifactLink(`initiative:${item.initiative.id}`, ctx, item.initiative.title);
  const slice = item.slice ? artifactLink(`slice:${item.initiative.id}/${item.slice.slug}`, ctx, item.slice.title) : null;
  return workRow(initiative, slice, item.slice && !PHASE_KINDS.has(item.kind) ? gatePhase(item) : null);
}
const ASKER_STATES = {
  waiting: { label: "Waits for your answer", icon: "check-circle", tone: "success", tip: () => "Waits for your answer. This session is waiting on this question and picks up your answer within a minute or so." },
  open: { label: "Open, not waiting", icon: "info", tone: "info", tip: () => "Open, not waiting. This session is open but no longer waits on this question, so it reads your answer only with the next message it gets in its own conversation." },
  "not-running": { label: "Not running", icon: "clock", tone: "neutral", tip: () => "Not running. The session that asked has stopped. It reads your answer the next time it runs, or you can continue the work from here once you have answered." },
  unknown: {
    label: "Prism can't see this session",
    icon: "warning",
    tone: "warning",
    tip: (asker) => asker.known && asker.cloud ? "Prism can't see this session. It runs in the cloud, so this computer can't tell whether it is still open or waiting. If it is waiting, it picks up your answer within a minute or so. If it was closed, it gets your answer the next time it runs, or when you send it any message in its own conversation. To be sure, open the session and say \u201Cgo\u201D." : `Prism can't see this session. ${asker.reason ?? "This computer can't tell whether it is still open or waiting."} If it is waiting, it picks up your answer within a minute or so. If not, it gets your answer the next time it runs, or when you send it any message in its own conversation.`
  }
};
const askerName = (asker) => asker.known ? `${asker.harness ?? "An unnamed harness"} on ${asker.machine ?? "an unnamed machine"}` : "An unknown session";
function gateWithdraw(item) {
  if (item.answer || item.unavailable || !item.asker || item.asker.state === "waiting" || item.asker.state === "open") return "";
  return `<div class="gate-withdraw" data-gate="${escapeHtml(item.id)}" data-withdraw-target="${escapeHtml(answerTarget(item))}"></div>`;
}
function wakeLine(wake) {
  if (wake.delivered) return `<p class="gate-asker-note" data-wake="delivered"><prism-icon name="check-circle" size="xs" tone="ok"></prism-icon><span>Wake sent ${liveTime(wake.at)}</span></p>`;
  return `<p class="gate-asker-note" data-wake="not-delivered"><prism-icon name="warning" size="xs" tone="danger"></prism-icon><span>${escapeHtml(`Wake not delivered: ${wake.reason ?? "Claude Code gave no reason."}`)}</span></p>`;
}
function gateAsker(item) {
  const asker = item.asker;
  if (!asker) return "";
  const where2 = asker.known ? `${asker.checkout ?? "an unnamed checkout"}${asker.cloud ? " \xB7 cloud session" : ""}` : "";
  const look = ASKER_STATES[asker.state] ?? ASKER_STATES.unknown;
  const state = `<prism-icon class="gate-asker-state" name="${look.icon}" tone="${look.tone}" size="sm" label="${escapeHtml(look.label)}" tip="${escapeHtml(look.tip(asker))}" tabindex="0"></prism-icon>`;
  const wake = asker.wake ? wakeLine(asker.wake) : "";
  return `<section class="gate-asker" aria-label="Asked by">
    <p class="label-caps">Asked by</p>
    <div class="gate-asker-line"><prism-avatar kind="agent" size="sm" name="${escapeHtml(askerName(asker))}"${asker.state === "waiting" ? " live" : ""}></prism-avatar><div class="gate-asker-text"><p class="gate-asker-who"><strong>${escapeHtml(askerName(asker))}</strong>${state}</p>${where2 ? `<p class="gate-asker-where">${escapeHtml(where2)}</p>` : ""}</div></div>
    ${asker.reach ? `<p class="gate-asker-note">${escapeHtml(asker.reach)}</p>` : ""}${wake}${gateHolder(item)}
  </section>`;
}
function gateHolder(item) {
  const claim = liveHolder(item);
  if (!claim) return "";
  const left = timeLeft(claim.expiresAt).text ? `, ${liveTime(claim.expiresAt, { format: "left" })}` : "";
  return `<p class="gate-holder"><prism-claim variant="avatar"${claimAttributes(claim)}></prism-claim><span><strong>${escapeHtml(claim.label)}</strong> holds this slice for ${claim.activity === "design" ? "design" : "implementation"}${left}.</span></p>`;
}
function sendTo(item) {
  const asker = item.asker;
  if (!asker?.known) return "";
  return `<prism-avatar class="gate-send-to" kind="agent" size="sm" name="${escapeHtml(askerName(asker))}" tip="${escapeHtml(`Your answer goes to ${askerName(asker)}`)}"${asker.state === "waiting" ? " live" : ""}></prism-avatar>`;
}
function gateContext(item, ctx) {
  if (!item.context) return "";
  const body = ctx.renderMarkdown ? ctx.renderMarkdown(item.context) : `<p class="gate-context-plain">${escapeHtml(item.context)}</p>`;
  return `<div class="gate-block"><p class="label-caps">What happened</p><div class="gate-context">${body}</div></div>`;
}
function gateGuidance(item) {
  const recommended = item.recommended ?? null;
  const options = item.kind === "decision" ? item.options ?? [] : [];
  const pick = recommended?.option ? options.find((option) => option.id === recommended.option) : null;
  if (!recommended?.reason) return "";
  return `<div class="gate-block"><p class="label-caps">Recommended</p><p class="gate-recommendation">${pick ? `<strong>${escapeHtml(pick.label)}</strong>: ` : ""}${escapeHtml(recommended.reason)}</p></div>`;
}
function inspectLabel(artifact, ctx) {
  const record = artifact.record ?? null;
  const count = (value, word) => plural(Number.isInteger(value) ? value : 0, word);
  if (record?.kind === "design") return { label: `Design \xB7 ${count(record.clauses, "clause")} \xB7 ${count(record.frozenTests, "frozen test")}` };
  if (record?.kind === "change-map") return { label: `Change map \xB7 ${count(record.plannedChanges, "planned change")}` };
  if (record?.kind === "review-ledger") return { label: `Review ledger \xB7 ${count(record.openFindings, "open finding")}` };
  if (record?.kind === "decision") return { label: [record.title, "Decision", record.status].filter(Boolean).join(" \xB7 ") };
  if (record?.kind === "requirements") return { label: `${record.title} \xB7 Requirements` };
  const kind = recordKind(artifact.path);
  if (!kind) return { label: artifact.path, code: true };
  const named = ctx.describe?.(artifact.path) ?? recordLabel(artifact.path);
  if (named.code) return { label: artifact.path, code: true };
  return { label: named.label === named.kind ? named.kind : `${named.label} \xB7 ${named.kind}` };
}
const DOCUMENT_ICONS = { design: "document", "change-map": "grid", "review-ledger": "flask", decision: "scale", requirements: "document" };
const DOCUMENT_ORDER = { design: 0, "change-map": 1, "review-ledger": 2, decision: 3, requirements: 4 };
const SHOWN_DOCUMENTS = 5;
function documentRow(artifact, ctx) {
  const { label, code } = inspectLabel(artifact, ctx);
  const record = artifact.record ?? null;
  const segments = String(artifact.path).split("/");
  const folder = segments.slice(0, -1).join("/") || "repository root";
  let name, description;
  if (code) [name, description] = [segments.at(-1), `Source \xB7 ${folder}`];
  else if (record?.kind === "design" && record.title) [name, description] = [record.title, label];
  else {
    const [first, ...rest] = label.split(" \xB7 ");
    [name, description] = [first, rest.join(" \xB7 ")];
  }
  const icon = !artifact.available ? "warning" : code ? "code" : DOCUMENT_ICONS[record?.kind] ?? "file";
  const tone = !artifact.available ? "warning" : code ? "neutral" : "accent";
  const subject = code ? " data-code-subject" : "";
  const title = artifact.available && ctx.hasArtifact(artifact.path) ? `<a class="title-link" href="./review?artifact=${encodeURIComponent(artifact.path)}" data-artifact="${escapeHtml(artifact.path)}"${subject}>${escapeHtml(name)}</a>` : `<span${subject}>${escapeHtml(name)}</span>`;
  const mark = !artifact.available ? '<prism-badge slot="kind" variant="status" tone="warning">Not found</prism-badge>' : "";
  const open = artifact.available ? `<prism-button slot="action" variant="ghost" shape="square" size="sm" icon="panel" label="${escapeHtml(`Open ${name} in the side panel`)}" tip="Open in side panel" data-side-artifact="${escapeHtml(artifact.path)}"></prism-button>` : "";
  return `<prism-row wrap reveal${mark ? " stack" : ""} icon="${icon}" tone="${tone}">${title}${description ? `<span slot="description">${escapeHtml(description)}</span>` : ""}${mark}${open}</prism-row>`;
}
function documentsBlock(item, ctx) {
  const artifacts = item.artifacts ?? [];
  if (!artifacts.length) return "";
  const rank = (artifact) => artifact.record?.kind in DOCUMENT_ORDER ? DOCUMENT_ORDER[artifact.record.kind] : inspectLabel(artifact, ctx).code ? 6 : 5;
  const rows = artifacts.map((artifact, index) => ({ artifact, index })).sort((left, right) => rank(left.artifact) - rank(right.artifact) || left.index - right.index).map(({ artifact }) => documentRow(artifact, ctx));
  const list = (part, label) => `<div class="prism-rows gate-documents" role="list" aria-label="${label}">${part.join("")}</div>`;
  const rest = rows.slice(SHOWN_DOCUMENTS);
  const more = rest.length ? `<prism-disclosure class="gate-documents-more" summary="${escapeHtml(`${rest.length} more`)}">${list(rest, "More documents")}</prism-disclosure>` : "";
  const gone = item.stale ? `<p class="notice">Every file this question refers to is gone, so it may no longer apply. The agent that asked it withdraws it when it does not.</p>` : "";
  return `<div class="gate-block"><p class="label-caps">${escapeHtml(`Documents \xB7 ${artifacts.length}`)}</p>${list(rows.slice(0, SHOWN_DOCUMENTS), "Documents")}${more}${gone}</div>`;
}
function bindDocuments(container, ctx) {
  container.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-side-artifact]");
    if (!button || !container.contains(button) || !ctx.sidePanel) return;
    event.preventDefault();
    void ctx.sidePanel.show(button.dataset.sideArtifact);
  });
}
const answerTarget = (item) => item.kind === "approval" ? `approval:${item.id}` : `gate:${item.initiative.id}/${item.id}`;
function answerSlot(item) {
  const owner = item.kind === "approval" ? " data-approval" : ` data-initiative="${escapeHtml(item.initiative.id)}"`;
  return `<div class="gate-answer">${gateAsker(item)}<div class="gate-answer-form" data-gate="${escapeHtml(item.id)}"${owner} data-answer-target="${escapeHtml(answerTarget(item))}"><p class="muted action-loading">Loading\u2026</p></div>${gateWithdraw(item)}</div>`;
}
const ARCHIVE_SESSION = (launch) => `<prism-button variant="ghost" data-archive-session data-launch="${escapeHtml(launch.id)}" text="Archive session"></prism-button>`;
function answerFormOptions(item) {
  return {
    heading: "Your answer",
    tone: (option) => option.value === "request-changes" ? "danger" : null,
    leading: () => item.launch ? "" : sendTo(item),
    trailing: () => item.launch ? ARCHIVE_SESSION(item.launch) : "",
    wording: (_action, form) => {
      const words = answerState(item, { choice: form.input.choice ?? null, note: form.input.note ?? "" });
      return {
        field: { note: { label: noteLabel(words), placeholder: words.notePlaceholder } },
        submit: { label: words.submitLabel, variant: words.choice === "request-changes" ? "danger" : "primary" },
        hint: readyText(item, words, form.ready, form.hint),
        ready: form.ready
      };
    }
  };
}
function servedWork(item, ctx) {
  const work = item.workItem;
  if (!work?.initiative) return "";
  const { initiative, slice } = work;
  const unknown = (id, why) => `<span class="approval-work-part"><span data-code-subject>${escapeHtml(id)}</span> <span class="muted">${why}</span></span>`;
  const named = initiative.known ? artifactLink(`initiative:${initiative.id}`, ctx, initiative.title) : unknown(initiative.id, "not on the roadmap yet");
  const part = slice ? initiative.known && slice.known ? artifactLink(`slice:${initiative.id}/${slice.slug}`, ctx, slice.title) : unknown(slice.slug, "no slice yet") : null;
  return workRow(named, part, null, " approval-work");
}
function approvalDocument(item, ctx) {
  const path = item.artifact.path;
  const kind = item.artifact.kind === "adrs" ? "Decision" : "Requirements";
  const name = item.artifact.title || path.split("/").pop();
  const title = ctx.hasArtifact(path) ? `<a class="title-link" href="./review?artifact=${encodeURIComponent(path)}" data-artifact="${escapeHtml(path)}">${escapeHtml(name)}</a>` : `<span>${escapeHtml(name)}</span>`;
  const open = `<prism-button slot="action" variant="ghost" shape="square" size="sm" icon="panel" label="${escapeHtml(`Open ${name} in the side panel`)}" tip="Open in side panel" data-side-artifact="${escapeHtml(path)}"></prism-button>`;
  return `<div class="prism-rows gate-documents" role="list" aria-label="Document"><prism-row wrap reveal icon="${kind === "Decision" ? "scale" : "document"}" tone="accent">${title}<span slot="description">${kind} \xB7 <span data-code-subject>${escapeHtml(path)}</span></span>${open}</prism-row></div>`;
}
function approvalSubject(item, ctx) {
  const scope = item.artifact.scope?.label ?? "workspace";
  const status = (text, modifier) => `<span class="approval-status-value ${modifier}">${escapeHtml(text)}</span>`;
  const change = item.recorded && item.recorded !== item.status ? `<span class="approval-status">${status(item.recorded, "is-recorded")}<span class="approval-status-arrow" aria-hidden="true">\u2192</span><span class="sr-only">to</span>${status(item.status, "is-approved")}</span>` : `<span class="approval-status">${status(item.status, "is-approved")}</span>`;
  return `${keyValues([
    ["Document", approvalDocument(item, ctx)],
    ["Scope", chip(escapeHtml(scope))],
    ["Approving records", change]
  ])}
    ${item.ambiguous ? `<p class="notice">Another pending approval holds this question's id, so an answer cannot tell which file it approves and is refused. The agent asks again for the file it means.</p>` : ""}
    ${item.changed ? `<p class="notice">The file changed since this approval was asked, so approving it is refused. The agent asks again for the current version.</p>` : ""}`;
}
function unavailableAnswer(item) {
  return `<prism-banner class="gate-unavailable" tone="warning" heading="Cannot be answered"><p>${escapeHtml(item.unavailable)}</p></prism-banner>`;
}
function gateDetail(item, ctx) {
  if (item.kind === "assistance" && item.launch) return noResultDetail(item, ctx);
  if (item.kind === "approval") {
    return `<article class="gate attention-item gate-approval" aria-label="${escapeHtml(GATE_LABELS.approval)}">
    <header class="gate-head">
      ${gateHead(item, ctx, item.askedAt)}
    </header>
    <div class="gate-body">
      <div class="gate-main">
        ${gateContext(item, ctx)}
        ${approvalSubject(item, ctx)}
      </div>
      ${answerSlot(item)}
    </div>
  </article>`;
  }
  return `<article class="gate attention-item gate-${escapeHtml(item.kind)}" aria-label="${escapeHtml(GATE_LABELS[item.kind] ?? "Question")}">
    <header class="gate-head">
      ${gateHead(item, ctx, item.askedAt)}
    </header>
    <div class="gate-body">
      <div class="gate-main">
        ${gateContext(item, ctx)}
        ${gateGuidance(item)}
        ${documentsBlock(item, ctx)}
        ${item.stale && !item.artifacts?.length ? `<p class="notice">Every file this question refers to is gone, so it may no longer apply. The agent that asked it withdraws it when it does not.</p>` : ""}
      </div>
      ${item.unavailable ? `<div class="gate-answer">${gateAsker(item)}${unavailableAnswer(item)}</div>` : answerSlot(item)}
    </div>
  </article>`;
}
const NO_RESULT_CHIP = "Run ended without a result";
const NO_MESSAGE = "The run left no message.";
const LAST_MESSAGE = "\n\nIts last message:\n\n";
function lastMessage(context) {
  const text = typeof context === "string" ? context : "";
  const at = text.indexOf(LAST_MESSAGE);
  return at === -1 ? null : text.slice(at + LAST_MESSAGE.length);
}
function dayTime(at) {
  const time = Date.parse(at ?? "");
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const day = date.toLocaleDateString(void 0, { day: "numeric", month: "short" });
  const clock = date.toLocaleTimeString(void 0, { hour: "2-digit", minute: "2-digit" });
  return `<time datetime="${escapeHtml(at)}">${escapeHtml(`${day} ${clock}`)}</time>`;
}
function noResultDetail(item, ctx) {
  const launch = item.launch;
  const host = launch.host?.label ?? launch.host?.id ?? "";
  const message = lastMessage(item.context);
  const body = message === null ? `<p class="gate-last-message-none muted">${NO_MESSAGE}</p>` : `<div class="gate-last-message gate-context">${ctx.renderMarkdown ? ctx.renderMarkdown(message) : `<p class="gate-context-plain">${escapeHtml(message)}</p>`}</div>`;
  return `<article class="gate attention-item gate-assistance gate-no-result" aria-label="${NO_RESULT_CHIP}">
    <header class="gate-head">
      <div class="gate-chips">${badge(NO_RESULT_CHIP, "info")}<span class="attention-where">${escapeHtml(sessionPlace(item.initiative, launch.host))}</span>${when(item.askedAt, "attention-time gate-time")}</div>
      <h3 class="gate-question">${escapeHtml(item.question)}</h3>
    </header>
    <div class="gate-body">
      <div class="gate-main">
        ${keyValues([
    ["Initiative", escapeHtml(item.initiative?.title ?? item.initiative?.id ?? "")],
    ["Host", escapeHtml(host)],
    ["Launched", dayTime(launch.launchedAt)],
    ["Ended", dayTime(launch.endedAt)]
  ])}
        <div class="gate-block"><p class="label-caps">Last message</p>${body}</div>
      </div>
      ${item.unavailable ? unavailableAnswer(item) : answerSlot(item)}
    </div>
  </article>`;
}
function given(item) {
  const negative = item.answer.choice === "request-changes";
  return `${badge(choiceLabel(item, item.answer.choice), negative ? "danger" : "success")}${item.answer.note ? ` <span>${escapeHtml(item.answer.note)}</span>` : ""}`;
}
function detailSheet({ head = "", title, body = "", className = "" }) {
  return `<article class="gate attention-item ${className}">
    <header class="gate-head"><div class="gate-chips">${head}</div><h3 class="gate-question">${title}</h3></header>
    ${body ? `<div class="gate-main">${body}</div>` : ""}
  </article>`;
}
function answeredDetail(item, ctx) {
  return detailSheet({
    className: `is-answered gate-${escapeHtml(item.kind)}`,
    head: `${kindChip(item)}<span class="attention-where">${location(item, ctx)}</span>${when(item.answer.answeredAt, "attention-time gate-time")}`,
    title: escapeHtml(item.question),
    body: `${gateAsker(item)}<p class="gate-given">${given(item)}</p>${gateContinue(item)}<p class="attention-footnote muted">An agent that is waiting for these answers resumes on its own shortly after your last answer. Any other agent receives them with your next message in its conversation, even a short one such as \u201Cgo\u201D.</p>`
  });
}
function gateContinue(item) {
  const asker = item.asker;
  if (!asker || item.unavailable || asker.state === "waiting" || asker.state === "open" || asker.launched) return "";
  return `<div class="gate-continue" data-gate="${escapeHtml(item.id)}" data-continue-target="${escapeHtml(answerTarget(item))}"></div>`;
}
const CONTINUE_DEADLINE_MS = 33e4;
const CONTINUE_HINT = "Nothing starts until you confirm outside the browser.";
const CONTINUE_PICK = "Pick a way to continue.";
const withdrawFormOptions = {
  wording: (action, form) => ({ submit: { label: action.label, variant: "ghost" }, hint: form.ready ? action.effect : form.hint, ready: false })
};
const continueFormOptions = {
  heading: "Continue the work",
  wording: (_action, form) => ({ submit: { label: "Continue", variant: "primary" }, hint: form.ready ? CONTINUE_HINT : form.hint && CONTINUE_PICK, ready: form.ready }),
  unavailable: (action) => (action.fields?.[0]?.options ?? []).filter((option) => option.reason).map((option) => `<p class="action-reason">${escapeHtml(`${option.label}: ${option.reason}`)}</p>`).join("")
};
function closedDetail(item, ctx) {
  const outcome = item.answer ? given(item) : badge(item.reason === "The person withdrew this question without an answer." ? "Withdrawn" : "Closed by the agent");
  return detailSheet({
    className: `is-closed gate-${escapeHtml(item.kind)}`,
    head: `${kindChip(item)}<span class="attention-where">${location(item, ctx)}</span>${when(item.closedAt, "attention-time gate-time")}`,
    title: escapeHtml(item.question),
    body: `<p class="gate-given">${outcome}</p>${item.reason ? `<p class="muted">${escapeHtml(item.reason)}</p>` : ""}`
  });
}
function answerError(error) {
  if (error.code === "action_unavailable" || error.code === "gate_answered") return { message: error.message, rerender: true };
  if (error.code === "unknown_gate") return { message: "The agent already resolved or withdrew this question.", rerender: true };
  if (error.code === "artifact_changed") return { message: "The file changed since this approval was asked, so nothing was recorded. The agent asks again for the current version.", rerender: true };
  if (error.code === "approval_ambiguous") return { message: "Another pending approval holds this question's id, so nothing was recorded. The agent asks again for the file it means.", rerender: true };
  if (error.code === "author_unknown") return { message: "Git names no user for this checkout, so the approval cannot record who gave it. Set one with git config user.name, then answer again.", rerender: false };
  return { message: error.message, rerender: false };
}
function mountAnswers(container, ctx, gates) {
  const lists = [];
  if (!ctx.actionApi) return lists;
  const drafts = ctx.state.answerDrafts ??= {};
  for (const slot of container.querySelectorAll(".gate-answer-form[data-answer-target]")) {
    const item = gates.find((gate) => gate.id === slot.dataset.gate && answerTarget(gate) === slot.dataset.answerTarget);
    if (!item) continue;
    const target = slot.dataset.answerTarget;
    lists.push(createActionList({
      root: slot,
      targets: [target],
      api: ctx.actionApi,
      drafts,
      renderMarkdown: ctx.renderMarkdown ?? null,
      groups: ["Question"],
      actions: ["gate.answer"],
      emptyText: "This question takes no answer here.",
      form: answerFormOptions(item),
      onApplied: () => {
        ctx.showToast(item.launch ? "Answer recorded. The launched session resumes with it." : "Answer recorded. An agent that is waiting resumes on its own; any other agent sees it with your next message.");
        ctx.rerender();
      },
      // The server stays the backstop: its refusal shows beside the form in words, and a question that changed under the page is read again.
      onRefused: (_action, result) => {
        const refusal = answerError({ code: result.code === "unknown_target" ? "unknown_gate" : result.code, message: result.reason ?? result.message ?? "The answer was not recorded." });
        if (refusal.rerender) queueMicrotask(() => ctx.rerender());
        return refusal.message;
      }
    }));
  }
  return lists;
}
function mountGateActions(container, ctx) {
  const lists = [];
  if (!ctx.actionApi) return lists;
  const drafts = ctx.state.answerDrafts ??= {};
  const refused = (fallback) => (_action, result) => {
    const refusal = answerError({ code: result.code === "unknown_target" ? "unknown_gate" : result.code, message: result.reason ?? result.message ?? fallback });
    if (refusal.rerender) queueMicrotask(() => ctx.rerender());
    return refusal.message;
  };
  const mount = (slot, target, id, options) => {
    slot.hidden = true;
    lists.push(createActionList({
      root: slot,
      targets: [target],
      drafts,
      renderMarkdown: ctx.renderMarkdown ?? null,
      groups: ["Question"],
      actions: [id],
      emptyText: "",
      notice: false,
      onRender: () => {
        slot.hidden = !slot.querySelector("[data-action-key]");
      },
      ...options
    }));
  };
  for (const slot of container.querySelectorAll(".gate-withdraw[data-withdraw-target]")) {
    mount(slot, slot.dataset.withdrawTarget, "gate.withdraw", {
      api: ctx.actionApi,
      form: withdrawFormOptions,
      onApplied: () => {
        ctx.showToast("Question withdrawn. No session starts, and a session that comes back to it learns that it was withdrawn.");
        ctx.rerender();
      },
      onRefused: refused("The question was not withdrawn.")
    });
  }
  const api = continueApi(ctx.actionApi);
  for (const slot of container.querySelectorAll(".gate-continue[data-continue-target]")) {
    mount(slot, slot.dataset.continueTarget, "gate.continue", {
      api,
      form: continueFormOptions,
      onApplied: (_action, _input, result) => {
        const wake = result?.wake;
        ctx.showToast(wake ? wake.delivered ? "The wake was sent. The cloud session reads your answer from Prism's records." : `The wake was not delivered: ${wake.reason ?? "Claude Code gave no reason."}` : "The work continues. The new session acts first on your answer.");
        ctx.rerender();
      },
      onRefused: refused("Nothing started.")
    });
  }
  return lists;
}
const continueApis = /* @__PURE__ */ new WeakMap();
function continueApi(actionApi) {
  if (!continueApis.has(actionApi)) continueApis.set(actionApi, { ...actionApi, apply: (request) => actionApi.apply(request, { deadlineMs: CONTINUE_DEADLINE_MS }) });
  return continueApis.get(actionApi);
}
function sessionPlace(initiative, host) {
  return [initiative?.title ?? initiative?.id, host?.label ?? host?.id].filter(Boolean).join(" \xB7 ");
}
function permissionDetail(item, draft = {}) {
  const host = item.host?.label ?? item.host?.id ?? "The host";
  const key = escapeHtml(item.id);
  const busy = draft.sending ? " disabled" : "";
  return `<article class="gate attention-item gate-permission" aria-label="Permission">
    <header class="gate-head">
      <div class="gate-chips">${badge("Permission", "warning")}<span class="attention-where">${escapeHtml(sessionPlace(item.initiative, item.host))}</span>${when(item.askedAt, "attention-time gate-time")}</div>
      <h3 class="gate-question">${escapeHtml(host)} asks you to allow: ${escapeHtml(item.action)}</h3>
    </header>
    <div class="gate-body">
      <div class="gate-main">
        ${keyValues([
    ["Initiative", escapeHtml(item.initiative?.title ?? item.initiative?.id ?? "")],
    ["Host", escapeHtml(host)],
    ["Action", `<code class="permission-action" data-code-subject>${escapeHtml(item.action)}</code>`],
    ["Reason", `<span class="permission-reason">${escapeHtml(item.reason ?? "")}</span>`]
  ])}
        <p class="attention-footnote muted">The session waits until you answer. An allow covers this one request only.</p>
      </div>
      <div class="permission-answer" data-permission="${key}" data-launch="${escapeHtml(item.launch)}">
        <div class="permission-buttons">
          <prism-button variant="primary" icon="lock" text="Allow" data-permission-decision="approve"${busy}></prism-button>
          <prism-button text="Refuse" data-permission-decision="refuse"${busy}></prism-button>
        </div>
        <p class="permission-hint muted" id="permission-hint-${key}" aria-live="polite">${escapeHtml(draft.sending === "approve" ? "Confirm or refuse in the dialog on this computer." : "You confirm outside the browser.")}</p>
        <p class="gate-error" id="permission-error-${key}" role="alert"${draft.error ? "" : " hidden"}>${escapeHtml(draft.error ?? "")}</p>
      </div>
    </div>
  </article>`;
}
const PERMISSION_DEADLINE_MS = 2e5;
function permissionError(code, message) {
  const text = typeof message === "string" && message ? message : "The answer was not applied.";
  if (code === "unknown_request") return { message: "This request no longer waits: the session answered it, withdrew it, or ended.", rerender: true };
  if (typeof code === "string" && code.startsWith("confirmation_")) return { message: `The approval was not confirmed, so the request still waits. ${text}`, rerender: false };
  return { message: text, rerender: false };
}
function bindArchiveSession(container, ctx) {
  container.querySelector(".attention-detail")?.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-archive-session]");
    if (!button || button.hasAttribute("disabled")) return;
    button.setAttribute("disabled", "");
    const headers = { "Content-Type": "application/json", ...typeof ctx.writeHeaders === "function" ? ctx.writeHeaders() : {} };
    const response = await fetch("./api/agents/archive", { method: "POST", headers, body: JSON.stringify({ launch: button.dataset.launch }) }).catch(() => null);
    const json = response ? await response.json().catch(() => ({})) : { message: "The review app did not answer, so nothing changed. Try again in a moment." };
    if (response?.status === 200) {
      ctx.showToast("Archived. The Agents page keeps it under Archived.");
      ctx.rerender();
      return;
    }
    button.removeAttribute("disabled");
    ctx.showToast(json?.message ?? "The session could not be archived.");
  });
}
function bindPermissions(container, ctx) {
  const drafts = ctx.state.permissionDrafts ??= {};
  for (const form of container.querySelectorAll(".permission-answer")) {
    const id = form.dataset.permission;
    const launch = form.dataset.launch;
    const buttons = [...form.querySelectorAll("[data-permission-decision]")];
    const hint = form.querySelector(".permission-hint");
    const failure = form.querySelector(".gate-error");
    for (const button of buttons) {
      button.addEventListener("click", async () => {
        const decision = button.dataset.permissionDecision;
        const draft = drafts[id] ??= {};
        if (draft.sending) return;
        draft.sending = decision;
        draft.error = null;
        failure.hidden = true;
        for (const each of buttons) each.setAttribute("disabled", "");
        if (decision === "approve") hint.textContent = "Confirm or refuse in the dialog on this computer.";
        const result = await ctx.actionApi.apply({ action: "launch.permission", target: `launch:${launch}`, input: { request: id, decision }, revision: null }, { deadlineMs: PERMISSION_DEADLINE_MS });
        draft.sending = null;
        if (result.status === 200) {
          delete drafts[id];
          ctx.showToast(decision === "approve" ? "Allowed. The session goes on with this one request." : "Refused. The session was told that you refused.");
          ctx.rerender();
          return;
        }
        const refusal = permissionError(result.json?.code, result.json?.reason ?? result.json?.message);
        draft.error = refusal.message;
        failure.textContent = refusal.message;
        failure.hidden = false;
        hint.textContent = "You confirm outside the browser.";
        for (const each of buttons) each.removeAttribute("disabled");
        if (refusal.rerender) ctx.rerender();
      });
    }
  }
}
function changeLabel(action) {
  const words = String(action ?? "").split(".").pop().replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Change";
}
function changeValue(value) {
  if (value === null || value === void 0) return "none";
  if (typeof value === "object") return Object.entries(value).filter(([, item]) => item !== null && item !== "").map(([key, item]) => `${key}: ${typeof item === "object" ? JSON.stringify(item) : item}`).join(", ") || "none";
  return String(value);
}
function changeAuthor(by) {
  return by?.name || by?.email || "An unknown person";
}
function changeWhere(entry, ctx) {
  const [kind, rest = ""] = String(entry.target ?? "").split(/:(.*)/s);
  const parts = [];
  if (entry.initiative) parts.push(artifactChip(`initiative:${entry.initiative}`, ctx, entry.initiative));
  if (kind === "index") parts.push(`<code class="recent-change-target" data-code-subject>${escapeHtml(rest)}</code>`);
  if (kind === "gate" && !entry.question) parts.push('<span class="muted">question</span>');
  if (entry.artifact && typeof entry.artifact.path === "string") {
    parts.push(`<code class="recent-change-target" data-code-subject>${escapeHtml(entry.artifact.path)}</code>`, chip(escapeHtml(entry.artifact.scope?.label ?? "workspace")));
  }
  if (kind === "approval") parts.push('<span class="muted">approval</span>');
  return parts.join('<span class="crumb-separator" aria-hidden="true">\u203A</span>');
}
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const COMMENT_SHOWN = 280;
function changeStep(before, after) {
  return `<span class="recent-change-before">${escapeHtml(before)}</span> <span aria-hidden="true">\u2192</span><span class="sr-only">to</span> <span class="recent-change-after">${escapeHtml(after)}</span>`;
}
function changeValues(entry) {
  if (entry.action === "gate.answer") return escapeHtml(changeValue(entry.after));
  if (entry.action === "artifact.comment" && isObject(entry.after)) {
    const text = String(entry.after.text ?? "");
    return `<span class="recent-change-part">Line ${escapeHtml(String(entry.after.line ?? ""))}: ${escapeHtml(text.length > COMMENT_SHOWN ? `${text.slice(0, COMMENT_SHOWN)}\u2026` : text)}</span>`;
  }
  if (isObject(entry.before) && isObject(entry.after)) {
    const keys = [.../* @__PURE__ */ new Set([...Object.keys(entry.before), ...Object.keys(entry.after)])].filter((key) => JSON.stringify(entry.before[key] ?? null) !== JSON.stringify(entry.after[key] ?? null));
    if (keys.length) return keys.map((key) => `<span class="recent-change-part">${escapeHtml(key)}: ${changeStep(changeValue(entry.before[key]), changeValue(entry.after[key]))}</span>`).join("; ");
  }
  return changeStep(changeValue(entry.before), changeValue(entry.after));
}
function authorText(by) {
  const name = changeAuthor(by);
  return by?.email && by.email !== name ? `${escapeHtml(name)} <span class="muted">(${escapeHtml(by.email)})</span>` : escapeHtml(name);
}
function changeHtml(entry, ctx) {
  const values = changeValues(entry);
  return `<li class="recent-change" data-change="${escapeHtml(entry.id)}">
    <div class="attention-head">${badge(changeLabel(entry.action))}<span class="attention-where">${changeWhere(entry, ctx)}</span>${when(entry.at)}</div>
    ${entry.question ? `<p class="recent-change-question">${escapeHtml(entry.question)}</p>` : ""}
    <p class="recent-change-values">${values}</p>
    <p class="recent-change-by muted"><span>${authorText(entry.by)}</span> \xB7 <span>${escapeHtml(entry.by?.checkout ?? "an unknown checkout")}</span></p>
  </li>`;
}
const RECENT_LIMIT = 20;
let following = null;
function followChanges(container, ctx, questions) {
  if (!following) document.addEventListener("prism:action", (event) => following?.(event));
  following = (event) => {
    if (!container.isConnected) return;
    const entry = event.detail?.action === "gate.answer" && !event.detail.question && questions.has(event.detail.target) ? { ...event.detail, question: questions.get(event.detail.target) } : event.detail;
    const slot = container.querySelector("[data-recent-changes]");
    if (!slot || !entry?.id || slot.querySelector(`[data-change="${CSS.escape(entry.id)}"]`)) return;
    let list = slot.querySelector("ul");
    if (!list) {
      slot.innerHTML = '<ul class="recent-changes"></ul>';
      list = slot.querySelector("ul");
    }
    list.insertAdjacentHTML("afterbegin", changeHtml(entry, ctx));
    while (list.children.length > RECENT_LIMIT) list.lastElementChild.remove();
  };
}
function noteEntry(item, ctx) {
  const roadmapLink = artifactChip("roadmap", ctx, "Roadmap");
  const describe = {
    "pending-note": () => ({ kind: "Pending item", icon: "document", tone: "neutral", title: escapeHtml(item.text), text: "", where: location(item, ctx), meta: item.initiative?.title ?? "" }),
    unlisted: () => ({ kind: "Needs prioritization", icon: "roadmap", tone: "warning", title: `${escapeHtml(item.initiative.title ?? item.initiative.id)} is not on the roadmap`, text: `${escapeHtml(item.initiative.title ?? item.initiative.id)} has an initiative record but no roadmap entry. Ask the agent to run <code>roadmap</code>.`, where: location(item, ctx), meta: "Needs prioritization" }),
    "open-question": () => ({ kind: "Roadmap question", icon: "roadmap", tone: "neutral", title: escapeHtml(item.text), text: "", where: roadmapLink, meta: "Open question on the roadmap" }),
    "roadmap-missing": () => ({ kind: "No roadmap", icon: "warning", tone: "warning", title: "No roadmap", text: "No roadmap record exists yet. Ask the agent to run <code>setup</code>.", where: "", meta: "Roadmap" }),
    "roadmap-problem": () => ({ kind: "Roadmap problem", icon: "warning", tone: "danger", title: "The roadmap has a problem", text: messageHtml(item.message), where: roadmapLink, meta: "Roadmap problem" }),
    config: () => ({ kind: "Workflow settings", icon: "warning", tone: "warning", title: "Check the workflow settings", text: messageHtml(item.message), where: "", meta: "Workflow settings" }),
    "format-findings": () => ({ kind: "Format findings", icon: "document", tone: "warning", title: formatTitle(item), text: `${escapeHtml(formatSummary(item))} ${artifactLink("attention:formats", ctx, "See the findings")}`, where: "", meta: "Format findings" })
  }[item.type];
  if (item.type === "migration-question" || item.type === "migration-failed") return runEntry(item, ctx);
  const content = describe ? describe() : { kind: item.type, icon: "info", tone: "neutral", title: escapeHtml(item.type), text: "", where: "", meta: "" };
  return {
    row: { icon: content.icon, tone: content.tone, title: content.title, meta: escapeHtml(content.meta) },
    detail: detailSheet({ className: `note-${escapeHtml(item.type)}`, head: `${badge(content.kind)}<span class="attention-where">${content.where}</span>`, title: content.title, body: content.text ? `<p class="attention-note">${content.text}</p>` : "" })
  };
}
const runRef = (item) => `migration-run:${item.run}`;
const runTitle = (item) => `Format migration \xB7 ${item.label} ${scopeWords(item.scope)}`;
const runCode = (path) => `<span class="run-code" data-code-subject>${escapeHtml(path)}</span>`;
const openRun = (item, label, variant = "") => `<prism-button${variant ? ` variant="${variant}"` : ""} data-artifact="${escapeHtml(runRef(item))}">${escapeHtml(label)}</prism-button>`;
function runEntry(item, ctx) {
  const where2 = `<span class="attention-where">${whereChip(item.scope)}</span>`;
  if (item.type === "migration-question") {
    const files2 = item.asking ?? [];
    const title2 = escapeHtml(runTitle(item));
    const rows2 = `<div class="prism-rows" role="list" aria-label="Files that ask you">${files2.map((file) => `<prism-row icon="document" tone="accent">${runCode(file.path)}<span slot="description">${escapeHtml(file.kinds.map((kind) => POINT_KINDS[kind] ?? kind).join(", "))}</span><prism-badge slot="kind" tone="accent">${file.points}</prism-badge></prism-row>`).join("")}</div>`;
    const note = `Prism could not settle ${plural(item.points, "point")} in ${files2.length} of the run's ${plural(item.files, "file")}. One answer on the run's page settles all of them, each prefilled with Prism's recommendation.`;
    return {
      row: { icon: "layers", tone: "accent", unread: true, title: title2, meta: escapeHtml(`${plural(item.points, "point")} in ${files2.length} of ${plural(item.files, "file")} \xB7 Format migration`), end: shortTime(item.askedAt) },
      detail: detailSheet({ className: "note-migration-question", head: `${badge("Format migration asks you", "accent")}${where2}${when(item.askedAt, "attention-time gate-time")}`, title: title2, body: `<p class="attention-note">${escapeHtml(note)}</p>${rows2}<div class="gate-actions"><span></span>${openRun(item, "Answer on the run's page", "primary")}</div>` })
    };
  }
  const title = escapeHtml(`${runTitle(item)} failed`);
  const files = item.artifacts ?? [];
  const rows = `<div class="prism-rows" role="list" aria-label="Files in the run">${files.map((file) => `<prism-row icon="document" tone="neutral">${runCode(file.path)}</prism-row>`).join("")}</div>`;
  return {
    row: { icon: "warning", tone: "danger", unread: true, title, meta: escapeHtml(`${item.reason ?? "The run failed"} \xB7 Failed`), end: shortTime(item.at) },
    detail: detailSheet({ className: "note-migration-failed", head: `${badge("Format migration failed", "danger")}${where2}${when(item.at, "attention-time gate-time")}`, title, body: `<p class="attention-note run-reason">${escapeHtml(item.reason ?? "The run failed without a reason.")}</p><p class="muted">Nothing of the run was applied. Its ${plural(files.length, "file")} still ${files.length === 1 ? "breaks" : "break"} the format.</p>${rows}<div class="gate-actions">${openRun(item, "Open the run")}<prism-button variant="primary" data-migration-rerun="${escapeHtml(item.run)}">Run again</prism-button></div>` })
  };
}
function waitingRunEntry(item) {
  const title = escapeHtml(`${runTitle(item)} waits for a host`);
  return {
    row: { icon: "clock", tone: "warning", title, meta: escapeHtml(`${item.reason ?? "No host is available on this machine"} \xB7 Problem`) },
    detail: detailSheet({ className: "watch-migration-waiting", head: `${badge("Waits for a host", "warning")}<span class="attention-where">${whereChip(item.scope)}</span>`, title, body: `<p class="watch-detail run-reason">${escapeHtml(item.reason ?? "No host is available on this machine.")}</p><div class="gate-actions"><span></span>${openRun(item, "Open the run")}</div>` })
  };
}
function recordName(path, ctx) {
  const named = ctx.describe?.(path) ?? recordLabel(path);
  return named.code ? null : named.kind;
}
function watchEntry(item, ctx) {
  if (item.type === "migration-waiting") return waitingRunEntry(item);
  const where2 = location(item, ctx);
  const slice = item.slice?.title ?? item.initiative?.title ?? "";
  const describe = {
    blocked: () => ({ icon: "warning", tone: "danger", title: "The slice is blocked", meta: slice, head: badge("blocked", "danger"), text: "The slice is blocked." }),
    findings: () => ({ icon: "flask", tone: item.blocking ? "danger" : "warning", title: item.blocking ? plural(item.blocking, "blocking finding") : plural(item.unresolved, "open finding"), meta: `Review ledger \xB7 ${slice}`, head: item.blocking ? badge(plural(item.blocking, "blocking finding"), "danger") : badge(plural(item.unresolved, "open finding"), "warning"), text: artifactChip(item.path, ctx, "Open the findings board") }),
    active: () => ({ icon: "agent", tone: "info", title: `${escapeHtml(item.workers.join(", ") || "An agent")} ${item.activity === "design" ? "is designing" : "is implementing"}`, meta: `${slice}${item.label ? ` \xB7 ${item.label}` : ""}`, head: badge("active", "info"), text: `${escapeHtml(item.activity)}${item.label ? ` \xB7 ${escapeHtml(item.label)}` : ""} \xB7 ${escapeHtml(item.workers.join(", "))}` }),
    "failed-verification": () => ({ icon: "flask", tone: "danger", title: `${escapeHtml(slice)} failed verification`, meta: failedReason(item), head: badge("failed verification", "danger"), text: `${escapeHtml(failedReason(item))}${item.finishedAt ? ` \xB7 ${when(item.finishedAt)}` : ""}` }),
    "ready-to-ship": () => ({ icon: "check-circle", tone: "success", title: "Ready to ship", meta: slice, head: badge("ready to ship", "success"), text: "Every slice is done; the orchestrator records the ship decision at graduation." }),
    "record-problem": () => ({ icon: "warning", tone: "danger", title: "A record has a problem", meta: recordName(item.path, ctx) ?? "Record", head: badge("record problem", "danger"), text: `${artifactChip(item.path, ctx, recordName(item.path, ctx) ?? void 0)} ${escapeHtml(item.message)}` })
  }[item.type];
  const row = describe ? describe() : { icon: "info", tone: "neutral", title: escapeHtml(item.type), meta: "", head: badge(item.type), text: "" };
  return {
    row: { icon: row.icon, tone: row.tone, title: row.title, meta: escapeHtml(row.meta) },
    detail: detailSheet({ className: `watch-${escapeHtml(item.type)}`, head: `${row.head}<span class="attention-where">${where2}</span>`, title: row.title, body: row.text ? `<p class="watch-detail">${row.text}</p>` : "" })
  };
}
const RUN_REASONS = {
  command_failed: "The tests failed",
  timed_out: "The tests timed out",
  cancelled: "The run was cancelled",
  tracked_files_changed: "The run changed tracked files",
  frozen_tests_changed: "The frozen tests changed",
  start_content_missing: "The slice's start content is missing",
  component_boundary: "The change crossed its component's boundary"
};
function failedReason(item) {
  const words = RUN_REASONS[item.reason] ?? "The run failed";
  return Number.isInteger(item.failingCount) && item.failingCount > 0 ? `${words}, ${plural(item.failingCount, "test")} failed` : words;
}
function claimEntry(claim, ctx) {
  const where2 = location({ initiative: claim.initiative, slice: { slug: claim.slug, title: claim.sliceTitle } }, ctx);
  const left = timeLeft(claim.expiresAt);
  const expired = left.expired || claim.expired;
  const doing = claim.activity === "design" ? "is designing" : "is implementing";
  const title = expired ? `${escapeHtml(claim.label)}'s claim expired` : `${escapeHtml(claim.label)} ${doing}`;
  return {
    row: { start: `<prism-claim slot="start" variant="avatar"${claimAttributes(claim)}></prism-claim>`, title, meta: `${escapeHtml(claim.sliceTitle)}${left.text ? ` \xB7 ${liveTime(claim.expiresAt, { format: "left" })}` : ""}${expired ? " \xB7 free to take" : ""}`, end: expired ? shortTime(claim.expiresAt) : "live" },
    detail: detailSheet({ className: "watch-claim", head: `${badge(expired ? "claim expired" : "working", expired ? "warning" : "info")}<span class="attention-where">${where2}</span>`, title, body: `<p class="watch-detail"><prism-claim variant="strip"${claimAttributes(claim)}></prism-claim></p>` })
  };
}
function inboxRow(key, row) {
  return `<prism-inbox-item value="${escapeHtml(key)}"${row.icon && !row.start ? ` icon="${row.icon}" tone="${row.tone ?? "neutral"}"` : ""}${row.unread ? " unread" : ""}>${row.start ?? ""}${row.title}${row.meta ? `<span slot="description">${row.meta}</span>` : ""}${row.end ? `<span slot="end">${row.end}</span>` : ""}</prism-inbox-item>`;
}
function group(id, label, entries, { count = entries.length, tone = "neutral", note = "" } = {}) {
  if (!entries.length) return "";
  return `<section class="attention-group" aria-labelledby="attention-group-${id}">
    <h2 class="attention-group-label" id="attention-group-${id}"><span>${escapeHtml(label)}</span> <prism-badge tone="${tone}">${count}</prism-badge></h2>
    ${note ? `<p class="attention-footnote attention-group-note muted">${escapeHtml(note)}</p>` : ""}
    <prism-inbox label="${escapeHtml(label)}" data-inbox>${entries.map(({ key, row }) => inboxRow(key, row)).join("")}</prism-inbox>
  </section>`;
}
const PHONE_QUERY = "(max-width: 720px)";
let pendingSelection = null;
function openQuestion(ctx, gate) {
  if (gate) pendingSelection = `gate:${gate}`;
  ctx.openArtifact?.("attention");
}
function filterLine(container, text, ctx) {
  setPageSub(container, pageSub(escapeHtml(text), { end: '<a href="./review?artifact=attention" data-artifact="attention">Show everything</a>' }), ctx);
}
const where = (item) => [item.initiative?.title, item.slice?.title].filter(Boolean);
function filteredItem({ kind, item }, ctx) {
  const slice = item.slice?.title ?? "";
  const sliceRef = item.slice && item.initiative ? `slice:${item.initiative.id}/${item.slice.slug}` : null;
  const initiativeRef = item.initiative ? `initiative:${item.initiative.id}` : null;
  const plain = (...parts) => parts.filter(Boolean).map(escapeHtml).join(" \xB7 ");
  const look = {
    gate: () => ({ icon: KIND_LOOK[item.kind]?.icon ?? "question", tone: KIND_LOOK[item.kind]?.tone ?? "info", title: escapeHtml(item.question), ref: "attention", select: `gate:${item.id}`, sub: plain(...where(item), GATE_LABELS[item.kind] ?? item.kind), chip: ["Question", "accent"], at: item.askedAt, action: "Answer" }),
    "pending-note": () => ({ icon: "document", tone: "neutral", title: escapeHtml(item.text), ref: initiativeRef, sub: plain(item.initiative?.title, "pending item"), chip: ["Question", "accent"] }),
    findings: () => ({ icon: "eye", tone: "warning", title: escapeHtml(slice), ref: ctx.hasArtifact(item.path) ? item.path : sliceRef, sub: plain(item.initiative?.title, item.blocking ? plural(item.blocking, "blocking finding") : plural(item.unresolved, "open finding")), chip: ["Finding", "warning"] }),
    "failed-verification": () => ({ icon: "flask", tone: "danger", title: `${escapeHtml(slice)} failed verification`, ref: sliceRef, sub: plain(item.initiative?.title, failedReason(item)), chip: ["Failed verification", "danger"], at: item.finishedAt }),
    blocked: () => ({ icon: "warning", tone: "danger", title: `${escapeHtml(slice)} is blocked`, ref: sliceRef, sub: plain(item.initiative?.title, "blocked slice"), chip: ["Blocked", "danger"] }),
    "ready-to-ship": () => ({ icon: "check-circle", tone: "success", title: `${escapeHtml(item.initiative.title)} is ready to ship`, ref: initiativeRef, sub: "Every slice is done", chip: ["Ready to ship", "success"] }),
    "record-problem": () => ({ icon: "warning", tone: "danger", title: `${escapeHtml(recordName(item.path, ctx) ?? "A record")} has a problem`, ref: ctx.hasArtifact(item.path) ? item.path : initiativeRef, sub: [escapeHtml(item.initiative?.title ?? ""), messageHtml(item.message ?? "")].filter(Boolean).join(" \xB7 "), chip: ["Problem", "danger"] }),
    unlisted: () => ({ icon: "roadmap", tone: "warning", title: `${escapeHtml(item.initiative.title)} is not on the roadmap`, ref: initiativeRef, sub: "It has an initiative record but no roadmap entry", chip: ["Problem", "warning"] }),
    "open-question": () => ({ icon: "roadmap", tone: "neutral", title: escapeHtml(item.text), ref: "roadmap", sub: "Open question on the roadmap", chip: ["Problem", "warning"] }),
    "roadmap-missing": () => ({ icon: "warning", tone: "warning", title: "No roadmap", ref: null, sub: "No roadmap record exists yet; ask the agent to run setup", chip: ["Problem", "warning"] }),
    "roadmap-problem": () => ({ icon: "warning", tone: "danger", title: "The roadmap has a problem", ref: "roadmap", sub: messageHtml(item.message ?? ""), chip: ["Problem", "danger"] }),
    config: () => ({ icon: "warning", tone: "warning", title: "Check the workflow settings", ref: null, sub: messageHtml(item.message ?? ""), chip: ["Problem", "warning"] }),
    "format-findings": () => ({ icon: "document", tone: "warning", title: formatTitle(item), ref: "attention:formats", sub: escapeHtml(formatSummary(item)), chip: ["Format findings", "warning"] }),
    "migration-question": () => ({ icon: "layers", tone: "accent", title: escapeHtml(runTitle(item)), ref: runRef(item), sub: escapeHtml(`${plural(item.points, "point")} to answer \xB7 Format migration`), chip: ["Question", "accent"], at: item.askedAt, action: "Answer" }),
    "migration-failed": () => ({ icon: "warning", tone: "danger", title: escapeHtml(`${runTitle(item)} failed`), ref: runRef(item), sub: escapeHtml(item.reason ?? "The run failed"), chip: ["Failed", "danger"], at: item.at }),
    "migration-waiting": () => ({ icon: "clock", tone: "warning", title: escapeHtml(`${runTitle(item)} waits for a host`), ref: runRef(item), sub: escapeHtml(item.reason ?? "No host is available on this machine"), chip: ["Problem", "warning"] })
  }[item.type]?.() ?? { icon: "info", tone: "neutral", title: escapeHtml(item.type), ref: null, sub: "", chip: [kind, "neutral"] };
  const linked = look.ref && ctx.hasArtifact(look.ref);
  const select = look.select ? ` data-attention-select="${escapeHtml(look.select)}"` : "";
  const title = linked ? `<a href="./review?artifact=${encodeURIComponent(look.ref)}" data-artifact="${escapeHtml(look.ref)}"${select}>${look.title}</a>` : look.title;
  const time = liveTime(look.at, { format: "short", slot: "time" });
  const action = linked ? `<prism-button slot="action" size="sm" data-artifact="${escapeHtml(look.ref)}"${select}>${escapeHtml(look.action ?? "Open")}</prism-button>` : "";
  return `<prism-row icon="${escapeHtml(look.icon)}" tone="${escapeHtml(look.tone)}">${title}${look.sub ? `<span slot="description">${look.sub}</span>` : ""}<prism-chip slot="kind" tone="${escapeHtml(look.chip[1])}">${escapeHtml(look.chip[0])}</prism-chip>${time}${action}</prism-row>`;
}
function bindSelection(container) {
  container.addEventListener("click", (event) => {
    const chosen = event.target.closest?.("[data-attention-select]");
    if (chosen) pendingSelection = chosen.dataset.attentionSelect;
  }, { capture: true });
}
function renderFiltered(container, filter, ctx) {
  filterLine(container, `${filter.label} \xB7 ${filter.items.length} of ${filter.total} ${filter.total === 1 ? "item" : "items"}`, ctx);
  container.innerHTML = filter.items.length ? `<div class="prism-rows" role="list" aria-label="${escapeHtml(filter.label)}">${filter.items.map((entry) => filteredItem(entry, ctx)).join("")}</div>` : `<div class="attention-nothing">${emptyState("Nothing here waits on you", `No item of ${filter.label} needs you now.`)}</div>`;
  bindSelection(container);
  bindLinks(container, ctx);
}
function renderAnswered(container, answered, ctx) {
  filterLine(container, `Answered in the last 7 days \xB7 ${plural(answered.length, "question")}`, ctx);
  if (!answered.length) {
    container.innerHTML = `<div class="attention-nothing">${emptyState("Nothing answered this week", "No question was answered or closed in the last 7 days.")}</div>`;
    return;
  }
  container.innerHTML = `<div class="prism-rows" role="list" aria-label="Answered in the last 7 days">${answered.map((item) => {
    const place = [item.initiative ? artifactLink(`initiative:${item.initiative.id}`, ctx, item.initiative.title) : "", item.slice && item.initiative ? artifactLink(`slice:${item.initiative.id}/${item.slice.slug}`, ctx, item.slice.title) : ""].filter(Boolean).join(" \xB7 ");
    const outcome = item.answer ? given(item) : `${badge("Closed by the agent")}${item.reason ? ` <span>${escapeHtml(item.reason)}</span>` : ""}`;
    const tone = item.answer ? item.answer.choice === "request-changes" ? "danger" : "success" : "neutral";
    return `<prism-row wrap icon="${item.answer ? "check-circle" : "close"}" tone="${tone}">${escapeHtml(item.question)}${place ? `<span slot="description">${place}</span>` : ""}<span slot="detail">${outcome}</span><prism-chip slot="kind" tone="${item.answer ? "success" : "neutral"}">${item.answer ? "Answered" : "Closed"}</prism-chip>${liveTime(item.at, { format: "short", slot: "time" })}</prism-row>`;
  }).join("")}</div>`;
  bindLinks(container, ctx);
}
const formatTitle = (item) => `${escapeHtml(item.label)} \xB7 ${escapeHtml(plural(item.count, "file"))} ${item.count === 1 ? "breaks" : "break"} the format`;
const formatSummary = (item) => item.earlier ? `${item.earlier} of them ${item.earlier === 1 ? "keeps" : "keep"} an earlier Prism format.` : "None of them keeps a Prism format.";
function formatArtifact(artifact) {
  const scope = artifact.scope?.label ?? null;
  const mark = formatBadge({ rules: [...new Set((artifact.findings ?? []).map((finding) => finding.rule))].sort(), findings: artifact.findings ?? [] });
  const earlier = artifact.earlierFormat ? `Keeps format version ${artifact.earlierFormat.version}` : "Keeps no Prism format";
  return `<prism-row wrap icon="document" tone="warning"><span data-code-subject>${escapeHtml(artifact.path)}</span> ${mark}<span slot="description">${escapeHtml(earlier)} \xB7 ${plural((artifact.findings ?? []).length, "finding")}</span><span slot="detail">${findingsList(artifact.findings)}</span><prism-chip slot="kind"${scope ? ' tip="The record store scope that holds this file"' : ' tip="A file in this checkout"'}>${escapeHtml(scope ? `Scope ${scope}` : "Checkout")}</prism-chip></prism-row>`;
}
function formatGroup(label, note, artifacts) {
  if (!artifacts.length) return "";
  return `<section class="format-group"><h4 class="format-group-label label-caps"><span>${escapeHtml(label)}</span> <prism-badge tone="warning">${artifacts.length}</prism-badge></h4><p class="format-group-note muted">${escapeHtml(note)}</p><div class="prism-rows" role="list" aria-label="${escapeHtml(label)}">${artifacts.map(formatArtifact).join("")}</div></section>`;
}
function formatPanel(entry) {
  const earlier = entry.artifacts.filter((artifact) => artifact.earlierFormat);
  const foreign = entry.artifacts.filter((artifact) => !artifact.earlierFormat);
  return `<prism-panel class="view-section format-panel" heading="${escapeHtml(entry.label)}" level="3" eyebrow="${escapeHtml(`Format version ${entry.version} \xB7 ${plural(entry.count, "file")} to look at`)}">
    ${formatGroup("Earlier Prism format", `These files keep an earlier version of the format; a format migration brings them to version ${entry.version}.`, earlier)}
    ${formatGroup("No Prism format", "These files keep no version of the format; a format migration rewrites them into it, keeping every statement.", foreign)}
  </prism-panel>`;
}
function renderFormats(container, data, ctx) {
  const filter = data.filter;
  filterLine(container, `${filter.label} \xB7 ${filter.items.length} of ${filter.total} ${filter.total === 1 ? "item" : "items"}`, ctx);
  const shown = (data.formats ?? []).filter((entry) => entry.count);
  container.innerHTML = shown.length ? `<div class="format-panels">${shown.map(formatPanel).join("")}</div>` : `<div class="attention-nothing">${emptyState("Every file keeps its format", "No requirement, decision, glossary, or feature file breaks its Prism format.")}</div>`;
}
function render(container, entity, ctx) {
  if (entity.ref === "attention:formats" && entity.data.filter) return renderFormats(container, entity.data, ctx);
  if (entity.data.filter) return renderFiltered(container, entity.data.filter, ctx);
  if (entity.ref === "attention:answered") return renderAnswered(container, entity.data.answered ?? [], ctx);
  const data = entity.data;
  if (pendingSelection) {
    ctx.state.selected = pendingSelection;
    ctx.state.pane = "detail";
    pendingSelection = null;
  }
  const answered = data.answered ?? [];
  const earlier = data.earlier ?? [];
  const recent = data.recentChanges ?? [];
  const claims = data.claims ?? [];
  const gates = data.needsYou.filter((item) => item.type === "gate");
  const notes = data.needsYou.filter((item) => item.type !== "gate");
  const watched = data.watch.length + claims.length;
  const permissions = data.permissions ?? [];
  const permissionDrafts = ctx.state.permissionDrafts ??= {};
  const needs = [
    ...permissions.map((item) => ({
      key: `permission:${item.id}`,
      row: { icon: "lock", tone: "warning", unread: true, title: escapeHtml(item.action), meta: escapeHtml(["Permission", sessionPlace(item.initiative, item.host)].filter(Boolean).join(" \xB7 ")), end: shortTime(item.askedAt) },
      detail: permissionDetail(item, permissionDrafts[item.id] ?? {})
    })),
    ...gates.map((item) => ({
      key: `gate:${item.id}`,
      row: item.launch && item.kind === "assistance" ? { icon: "question", tone: "info", unread: true, title: escapeHtml(item.question), meta: escapeHtml([NO_RESULT_CHIP, sessionPlace(item.initiative, item.launch.host)].join(" \xB7 ")), end: shortTime(item.askedAt) } : { icon: KIND_LOOK[item.kind]?.icon ?? "question", tone: KIND_LOOK[item.kind]?.tone ?? "neutral", unread: true, title: escapeHtml(item.question), meta: escapeHtml([GATE_LABELS[item.kind] ?? item.kind, liveHolder(item) ? `${item.claim.label} is waiting on your answer` : item.slice?.title ?? item.initiative?.title ?? item.artifact?.path].filter(Boolean).join(" \xB7 ")), end: shortTime(item.askedAt) },
      detail: gateDetail(item, ctx)
    })),
    ...notes.map((item, index) => ({ key: `note:${index}`, ...noteEntry(item, ctx) }))
  ];
  const shippedRows = (data.shippedGates ?? []).map((item) => ({
    key: `shipped:${item.id}`,
    row: { icon: KIND_LOOK[item.kind]?.icon ?? "question", tone: "neutral", title: escapeHtml(item.question), meta: escapeHtml([GATE_LABELS[item.kind] ?? item.kind, "Cannot be answered", item.slice?.title ?? item.initiative?.title ?? item.artifact?.path].filter(Boolean).join(" \xB7 ")), end: shortTime(item.askedAt) },
    detail: gateDetail(item, ctx)
  }));
  const waiting = answered.map((item) => ({
    key: `answered:${item.id}`,
    row: { icon: "check", tone: "success", title: escapeHtml(item.question), meta: escapeHtml(`${choiceLabel(item, item.answer.choice)} \xB7 waiting for the agent`), end: shortTime(item.answer.answeredAt) },
    detail: answeredDetail(item, ctx)
  }));
  const watch = [
    ...data.watch.map((item, index) => ({ key: `watch:${index}`, ...watchEntry(item, ctx) })),
    ...claims.map((claim, index) => ({ key: `claim:${index}`, ...claimEntry(claim, ctx) }))
  ];
  const closed = earlier.map((item) => ({
    key: `closed:${item.id}`,
    row: { icon: KIND_LOOK[item.kind]?.icon ?? "question", tone: "neutral", title: escapeHtml(item.question), meta: escapeHtml([GATE_LABELS[item.kind] ?? item.kind, item.answer ? choiceLabel(item, item.answer.choice) : "Closed by the agent"].join(" \xB7 ")), end: shortTime(item.closedAt) },
    detail: closedDetail(item, ctx)
  }));
  const history = [{
    key: "recent",
    row: { icon: "clock", tone: "neutral", title: "Recent changes", meta: escapeHtml(recent.length ? `${plural(recent.length, "change")} from the review app` : "No changes from the review app yet"), end: shortTime(recent[0]?.at) },
    detail: detailSheet({ className: "recent-changes-sheet", head: badge("From the review app, newest first"), title: "Recent changes", body: `<div data-recent-changes>${recent.length ? `<ul class="recent-changes">${recent.map((entry) => changeHtml(entry, ctx)).join("")}</ul>` : emptyState("No changes yet", "No one changed settings, answered a question, or rebuilt an index from the review app yet.")}</div>` })
  }];
  const all = [...needs, ...shippedRows, ...waiting, ...watch, ...closed, ...history];
  if (!all.some((entry) => entry.key === ctx.state.selected)) ctx.state.selected = all[0].key;
  ctx.state.pane ??= typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches ? "list" : "detail";
  const selected = ctx.state.selected;
  container.innerHTML = `
    <div class="attention-inbox" data-pane="${ctx.state.pane}">
      <div class="attention-list" aria-label="Items that need you">
        ${needs.length ? group("needs", "Needs you", needs, { tone: "accent" }) : `<div class="attention-nothing">${emptyState("Nothing is waiting on you", "Questions an agent asks during an orchestrated run appear here.")}</div>`}
        ${group("shipped", "Shipped history", shippedRows, { note: "These questions were left open when their initiative shipped, so they can no longer be answered." })}
        ${group("answered", "Answered", waiting)}
        ${group("watch", "Watch", watch)}
        ${closed.length ? `<prism-disclosure class="attention-earlier" summary="${escapeHtml(`Earlier questions \xB7 ${closed.length}`)}"${closed.some((entry) => entry.key === selected) || ctx.state.earlierOpen ? " open" : ""}><prism-inbox label="Earlier questions" data-inbox>${closed.map(({ key, row }) => inboxRow(key, row)).join("")}</prism-inbox></prism-disclosure>` : ""}
        ${group("history", "History", history)}
        <div class="attention-list-foot">
          ${notifyControl(typeof Notification === "undefined" ? null : Notification.permission)}
          <p class="attention-footnote muted">The orchestrator records a question here while it waits on you during an orchestrated run. Direct skill runs, such as ideate or roadmap, still ask only in the conversation.</p>
        </div>
      </div>
      <div class="attention-detail">
        <prism-button class="attention-back" variant="ghost" size="sm" data-attention-back><prism-icon name="chevron-left" size="sm"></prism-icon>All items <prism-badge tone="accent">${needs.length}</prism-badge></prism-button>
        ${all.map((entry) => `<section class="attention-sheet" data-detail="${escapeHtml(entry.key)}"${entry.key === selected ? "" : " hidden"}>${entry.detail}</section>`).join("")}
      </div>
    </div>`;
  const head = container.parentElement?.querySelector(".artifact-header");
  if (head) {
    head.querySelector(".attention-stats")?.remove();
    head.insertAdjacentHTML("beforeend", `<div class="attention-stats">
      ${stat(`${gates.length + permissions.length === 1 ? "question waits" : "questions wait"} on you`, String(gates.length + permissions.length), { tone: gates.length + permissions.length ? "accent" : "success", attributes: ' layout="inline"' })}
      ${stat(`other ${notes.length === 1 ? "item needs" : "items need"} you`, String(notes.length), { attributes: ' layout="inline"' })}
      ${stat(`${watched === 1 ? "thing" : "things"} to watch`, String(watched), { attributes: ' layout="inline"' })}
    </div>`);
  }
  const inbox = container.querySelector(".attention-inbox");
  const lists = [...container.querySelectorAll("[data-inbox]")];
  const show = (key) => {
    ctx.state.selected = key;
    for (const list of lists) list.value = key;
    for (const sheet of container.querySelectorAll("[data-detail]")) sheet.hidden = sheet.dataset.detail !== key;
  };
  show(selected);
  for (const list of lists) {
    list.addEventListener("prism-select", (event) => {
      show(event.detail.value);
      if (inbox.dataset.pane === "list") {
        ctx.state.pane = inbox.dataset.pane = "detail";
        container.querySelector(".attention-detail")?.scrollIntoView?.({ block: "nearest" });
      }
    });
  }
  container.querySelector(".attention-earlier")?.addEventListener("toggle", (event) => {
    ctx.state.earlierOpen = event.detail.open;
  });
  container.querySelector("[data-attention-back]")?.addEventListener("click", () => {
    ctx.state.pane = inbox.dataset.pane = "list";
    lists.find((list) => list.value)?.focus();
  });
  bindLinks(container, ctx);
  const actionLists = [...mountAnswers(container, ctx, gates), ...mountGateActions(container, ctx)];
  for (const button of container.querySelectorAll("[data-migration-rerun]")) {
    button.addEventListener("click", async () => {
      button.toggleAttribute("disabled", true);
      if (await rerunRun(ctx, button.dataset.migrationRerun)) ctx.rerender();
      else button.toggleAttribute("disabled", false);
    });
  }
  bindPermissions(container, ctx);
  bindArchiveSession(container, ctx);
  bindDocuments(container, ctx);
  const questions = new Map([...gates, ...data.shippedGates ?? [], ...answered, ...earlier].filter((item) => item.initiative?.id).map((item) => [`gate:${item.initiative.id}/${item.id}`, item.question]));
  followChanges(container, ctx, questions);
  container.querySelector("[data-notify]")?.addEventListener("click", () => {
    void Notification.requestPermission().finally(() => ctx.rerender());
  });
  return ctx.redrawing ? void 0 : Promise.all(actionLists.map((list) => list.loaded));
}
export {
  NO_RESULT_CHIP,
  answerError,
  answerFormOptions,
  answerState,
  changeHtml,
  continueFormOptions,
  failedReason,
  gateDetail,
  inspectLabel,
  lastMessage,
  openQuestion,
  permissionDetail,
  permissionError,
  render,
  sessionPlace,
  withdrawFormOptions
};
