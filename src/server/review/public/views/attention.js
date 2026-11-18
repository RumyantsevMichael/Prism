import { artifactChip, artifactLink, badge, bindLinks, chip, emptyState, escapeHtml, keyValues, messageHtml, pageSub, plural, setPageSub, stat } from "./util.js";
import { recordKind, recordLabel } from "./entities.js";
import { claimAttributes } from "./claims.js";
import { isExpired } from "./claim-index.js";
import { notifyControl } from "./attention-signal.js";
import { currentPhase } from "./slice.js";
import { timeLeft } from "../kit/claim-time.js";

const GATE_LABELS = {
  "visual-review": "Visual review",
  correctness: "Correctness confirmation",
  decision: "Decision",
  assistance: "Action needed",
  approval: "Approval"
};

// The kind of a question as the glyph and tone of its row and the icon of its chip.
const KIND_LOOK = {
  "visual-review": { icon: "gate", tone: "accent", chip: "eye" },
  correctness: { icon: "gate", tone: "accent", chip: "check-circle" },
  decision: { icon: "question", tone: "info", chip: "question" },
  assistance: { icon: "warning", tone: "warning", chip: "warning" },
  approval: { icon: "gate", tone: "accent", chip: "check-circle" }
};

// A time in words that keeps itself current: 5 min ago, or for a row's narrow column 5 min or now, or 30 min left.
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
  return parts.join('<span class="crumb-separator" aria-hidden="true">›</span>');
}

const REVIEW_KINDS = new Set(["visual-review", "correctness", "approval"]);

// What each answer of a review gate leads to, shown under the option as a decision's consequence is.
const REVIEW_OUTCOMES = {
  approve: "The agent goes on with the work as it stands.",
  "request-changes": "The agent revises the work from your note before it goes on."
};

// An assistance gate has one answer, so its Send button gives it instead of a separate choice.
function choices(item) {
  if (REVIEW_KINDS.has(item.kind)) return [["approve", "Approve"], ["request-changes", "Request changes"]];
  if (item.kind === "assistance") return [];
  return (item.options ?? []).map((option) => [option.id, option.label]);
}

function choiceLabel(item, choice) {
  if (item.kind === "assistance" && choice === "done") return "Done";
  return choices(item).find(([id]) => id === choice)?.[1] ?? (choice ? choice : "Free answer");
}

// The form follows the server's answer rules, so Send is enabled only for an answer the server accepts, and the hint names what is missing.
// Nothing is guessed from the note: a review gate needs an explicit choice, and the note is kept whatever the person picks.
export function answerState(item, draft = {}) {
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
  if (item.kind === "assistance") return { choice, ready: true, ...optional, submitLabel: "Mark as done", hint: "" };
  if (options.length) {
    return { choice, ready: Boolean(choice) || hasNote, ...optional, notePlaceholder: "Add a note, or answer in your own words without picking an option", submitLabel: "Send answer", hint: choice || hasNote ? "" : "Pick an option or write your answer." };
  }
  return { choice, ready: hasNote, noteRequired: true, noteLabel: "Your answer", notePlaceholder: "Answer in your own words", submitLabel: "Send answer", hint: hasNote ? "" : "Write your answer to send it." };
}

// The note's label carries whether it is needed, as "Note for the agent · optional" does.
function noteLabel(state) {
  const label = state.noteLabel === "Note" ? "Note for the agent" : state.noteLabel;
  return `${label} · ${state.noteRequired ? "required" : "optional"}`;
}

// The line beside Send: what is missing, or, once the answer can go, who resumes with it.
function readyText(item, state) {
  if (state.hint) return state.hint;
  if (!state.ready) return "";
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
const PHASE_GATES = { requirements: "Requirements gate", design: "Design gate", frozen: "Design gate · tests frozen", build: "Build gate", review: "Review gate", shipped: "Ship gate" };

// The phase the gate's slice is in, from the phase facts the review model gives the gate, or null without them.
function gatePhase(item) {
  const facts = item.phase;
  if (!facts?.status) return null;
  return currentPhase({ status: facts.status, design: facts.designed ? { review: facts.review } : null });
}

function kindChip(item) {
  const look = KIND_LOOK[item.kind];
  return chip(`${look ? `<prism-icon name="${look.chip}" size="xs"></prism-icon> ` : ""}${escapeHtml(GATE_LABELS[item.kind] ?? item.kind)}`);
}

function gateHead(item, ctx, time) {
  const phase = gatePhase(item);
  const tag = phase !== null && phase < PHASES.length ? `<prism-phase variant="tag" phase="${PHASES[phase][0]}">${escapeHtml(PHASE_GATES[PHASES[phase][0]])}</prism-phase>` : "";
  const where = location(item, ctx);
  return `<div class="gate-chips">${tag}${kindChip(item)}${when(time, "attention-time gate-time")}</div>
    <h3 class="gate-question">${escapeHtml(item.question)}</h3>
    ${where ? `<p class="attention-where gate-where">${where}</p>` : ""}`;
}

// Whose work resumes once the gate is answered: the agent whose live claim holds the slice, for what, and how long the claim has left.
function gateHolder(item) {
  const claim = liveHolder(item);
  if (!claim) return "";
  const left = timeLeft(claim.expiresAt).text ? `, ${liveTime(claim.expiresAt, { format: "left" })}` : "";
  const holds = `It holds the slice for ${claim.activity === "design" ? "design" : "implementation"}${left}.`;
  return `<p class="gate-holder"><prism-claim variant="avatar"${claimAttributes(claim)}></prism-claim><span><strong>${escapeHtml(claim.label)}</strong> is waiting on your answer. ${holds}</span></p>`;
}

function gateSteps(item) {
  const current = gatePhase(item);
  if (current === null) return "";
  return `<prism-stepper class="gate-steps" label="Where this slice is in the workflow">${PHASES.map(([phase, label], index) => `<prism-step phase="${phase}" state="${index < current ? "done" : index === current ? "current" : "upcoming"}">${label}</prism-step>`).join("")}</prism-stepper>`;
}

// The situation the agent wrote for a person who has not followed the run, rendered as Markdown where the page can.
function gateContext(item, ctx) {
  if (!item.context) return "";
  const body = ctx.renderMarkdown ? ctx.renderMarkdown(item.context) : `<p class="gate-context-plain">${escapeHtml(item.context)}</p>`;
  return `<div class="gate-block"><p class="label-caps">What happened</p><div class="gate-context">${body}</div></div>`;
}

// The agent's recommendation, so the choice reads without the conversation; each option's consequence shows with the option itself.
function gateGuidance(item) {
  const recommended = item.recommended ?? null;
  const options = item.kind === "decision" ? (item.options ?? []) : [];
  const pick = recommended?.option ? options.find((option) => option.id === recommended.option) : null;
  if (!recommended?.reason) return "";
  return `<div class="gate-block"><p class="label-caps">Recommended</p><p class="gate-recommendation">${pick ? `<strong>${escapeHtml(pick.label)}</strong>: ` : ""}${escapeHtml(recommended.reason)}</p></div>`;
}

// A record attached to a gate reads by its title and kind with the counts that matter; a repository file keeps its path, since code is its subject.
export function inspectLabel(artifact, ctx) {
  const record = artifact.record ?? null;
  const count = (value, word) => plural(Number.isInteger(value) ? value : 0, word);
  if (record?.kind === "design") return { label: `Design · ${count(record.clauses, "clause")} · ${count(record.frozenTests, "frozen test")}` };
  if (record?.kind === "change-map") return { label: `Change map · ${count(record.plannedChanges, "planned change")}` };
  if (record?.kind === "review-ledger") return { label: `Review ledger · ${count(record.openFindings, "open finding")}` };
  if (record?.kind === "decision") return { label: [record.title, "Decision", record.status].filter(Boolean).join(" · ") };
  if (record?.kind === "requirements") return { label: `${record.title} · Requirements` };
  const kind = recordKind(artifact.path);
  if (!kind) return { label: artifact.path, code: true };
  const named = ctx.describe?.(artifact.path) ?? recordLabel(artifact.path);
  if (named.code) return { label: artifact.path, code: true };
  return { label: named.label === named.kind ? named.kind : `${named.label} · ${named.kind}` };
}

const INSPECT_ICONS = { design: "document", "change-map": "grid", "review-ledger": "flask", decision: "scale", requirements: "document" };

// An inspect tile shows the record's name on one line and its kind and counts below; the separator stays in the text between them, so the tile reads as its whole label.
function inspectTile(artifact, ctx) {
  const { label, code } = inspectLabel(artifact, ctx);
  const [name, ...rest] = code ? [label] : label.split(" · ");
  const kind = code ? (artifact.available ? "Source · read-only" : "Not found") : rest.join(" · ");
  const icon = code ? "code" : INSPECT_ICONS[artifact.record?.kind] ?? "file";
  const text = `<prism-icon name="${artifact.available ? icon : "warning"}"></prism-icon><span class="inspect-text"><span class="inspect-name"${code ? " data-code-subject" : ""}>${escapeHtml(name)}</span>${!code && kind ? '<span class="inspect-separator"> · </span>' : ""}<span class="inspect-kind">${escapeHtml(code && artifact.available ? kind : !artifact.available && !code ? `${kind} · not found` : kind)}</span></span>`;
  if (artifact.available && ctx.hasArtifact(artifact.path)) {
    return `<li><a class="inspect-tile" href="./review?artifact=${encodeURIComponent(artifact.path)}" data-artifact="${escapeHtml(artifact.path)}">${text}</a></li>`;
  }
  return `<li><span class="inspect-tile${artifact.available ? "" : " is-missing"}">${text}</span></li>`;
}

function inspectList(item, ctx) {
  if (!item.artifacts?.length) return "";
  return `<div class="gate-block"><p class="label-caps">Inspect</p><ul class="inspect-tiles">${item.artifacts.map((artifact) => inspectTile(artifact, ctx)).join("")}</ul></div>`;
}

// The figures the attached records give, as evidence for the answer: clauses, frozen tests, planned changes, and open findings.
function evidence(item) {
  const tiles = [];
  const order = { design: 0, "change-map": 1, "review-ledger": 2 };
  const records = [...(item.artifacts ?? [])].sort((left, right) => (order[left.record?.kind] ?? 3) - (order[right.record?.kind] ?? 3));
  for (const artifact of records) {
    const record = artifact.record;
    if (!artifact.available || !record) continue;
    if (record.kind === "design") {
      tiles.push(stat(record.clauses === 1 ? "contract clause" : "contract clauses", String(record.clauses ?? 0), { attributes: ' layout="figure" icon="document"' }));
      tiles.push(stat(record.frozenTests === 1 ? "frozen test, failing until built" : "frozen tests, failing until built", String(record.frozenTests ?? 0), { tone: record.frozenTests ? "success" : "", attributes: ' layout="figure" icon="lock"' }));
    }
    if (record.kind === "change-map") tiles.push(stat(record.plannedChanges === 1 ? "planned change" : "planned changes", String(record.plannedChanges ?? 0), { attributes: ' layout="figure" icon="grid"' }));
    if (record.kind === "review-ledger") tiles.push(stat(record.openFindings === 1 ? "open finding" : "open findings", String(record.openFindings ?? 0), { tone: record.openFindings ? "warning" : "", attributes: ' layout="figure" icon="flask"' }));
  }
  return tiles.length ? `<div class="gate-evidence" role="list" aria-label="Evidence">${tiles.map((tile) => `<span role="listitem">${tile}</span>`).join("")}</div>` : "";
}

function answerForm(item, draft) {
  const options = choices(item);
  const state = answerState(item, draft);
  const key = escapeHtml(item.id);
  const consequences = new Map((item.kind === "decision" ? item.options ?? [] : []).map((option) => [option.id, option.consequence]));
  if (REVIEW_KINDS.has(item.kind)) for (const [id, text] of Object.entries(REVIEW_OUTCOMES)) consequences.set(id, text);
  const optional = !REVIEW_KINDS.has(item.kind) && options.length > 0;
  const choice = options.length
    ? `<div class="gate-choices"><div class="gate-choices-head"><p class="label-caps" aria-hidden="true">Your answer</p>${optional ? `<prism-button size="sm" variant="ghost" data-clear-choice tip="Unchoose the option to answer in your own words"${state.choice ? "" : " hidden"}><prism-icon name="close" size="xs"></prism-icon>Clear choice</prism-button>` : ""}</div><prism-choice aria-label="Your answer" data-choice${optional ? " clearable" : ""}${state.choice ? ` value="${escapeHtml(state.choice)}"` : ""}>${options.map(([id, label]) => `<prism-choice-option value="${escapeHtml(id)}"${id === "request-changes" ? ' tone="danger"' : ""}>${escapeHtml(label)}${id === item.recommended?.option ? ` ${badge("Recommended", "accent")}` : ""}${consequences.get(id) ? `<span slot="detail">${escapeHtml(consequences.get(id))}</span>` : ""}</prism-choice-option>`).join("")}</prism-choice></div>`
    : '<p class="label-caps">Your answer</p>';
  const ready = readyText(item, state);
  // An approval gate is the target approval:<id> of the review app's actions, every other gate the target gate:<initiative>/<id>.
  const target = item.kind === "approval" ? " data-approval" : ` data-initiative="${escapeHtml(item.initiative.id)}"`;
  return `<div class="gate-answer" data-gate="${key}"${target}>
    ${choice}
    <prism-field class="gate-note" type="textarea" data-note label="${escapeHtml(noteLabel(state))}" placeholder="${escapeHtml(state.notePlaceholder)}"${state.noteRequired ? " required" : ""} value="${escapeHtml(draft.note ?? "")}"></prism-field>
    <div class="gate-actions"><p class="gate-hint${state.ready && !state.hint ? " is-ready" : ""}" id="gate-hint-${key}" aria-live="polite"><prism-icon name="check-circle" size="sm"${state.ready && !state.hint ? "" : " hidden"}></prism-icon><span class="gate-hint-text">${escapeHtml(ready)}</span></p><prism-button variant="${state.choice === "request-changes" ? "danger" : "primary"}" data-submit${state.ready ? "" : " disabled"}>${escapeHtml(state.submitLabel)}</prism-button></div>
    <p class="gate-error" id="gate-error-${key}" role="alert"${draft.error ? "" : " hidden"}>${escapeHtml(draft.error ?? "")}</p>
  </div>`;
}

// An approval gate names the requirement or ADR in full, with its scope and the status an approval records, since the answer applies to exactly that file.
// Both statuses are plain text that wraps, so the whole status that approving writes reads at every width; a status of up to 200 characters fits no one-line label.
function approvalSubject(item) {
  const scope = item.artifact.scope?.label ?? "workspace";
  const status = (text, modifier) => `<span class="approval-status-value ${modifier}">${escapeHtml(text)}</span>`;
  const change = item.recorded && item.recorded !== item.status
    ? `<span class="approval-status">${status(item.recorded, "is-recorded")}<span class="approval-status-arrow" aria-hidden="true">→</span><span class="sr-only">to</span>${status(item.status, "is-approved")}</span>`
    : `<span class="approval-status">${status(item.status, "is-approved")}</span>`;
  return `${keyValues([
      ["File", `<code class="approval-path" data-code-subject>${escapeHtml(item.artifact.path)}</code>`],
      ["Scope", chip(escapeHtml(scope))],
      ["Approving records", change]
    ])}
    ${item.ambiguous ? `<p class="notice">Another pending approval holds this question's id, so an answer cannot tell which file it approves and is refused. The agent asks again for the file it means.</p>` : ""}
    ${item.changed ? `<p class="notice">The file changed since this approval was asked, so approving it is refused. The agent asks again for the current version.</p>` : ""}`;
}

// A question the server no longer takes an answer to, such as one of a shipped initiative, names why in place of the form.
function unavailableAnswer(item) {
  return `<prism-banner class="gate-unavailable" tone="warning" heading="Cannot be answered"><p>${escapeHtml(item.unavailable)}</p></prism-banner>`;
}

export function gateDetail(item, ctx, draft) {
  if (item.kind === "approval") {
    return `<article class="gate attention-item gate-approval" aria-label="${escapeHtml(GATE_LABELS.approval)}">
    <header class="gate-head">
      ${gateHead(item, ctx, item.askedAt)}
    </header>
    <div class="gate-body">
      <div class="gate-main">
        ${approvalSubject(item)}
        ${gateContext(item, ctx)}
      </div>
      ${answerForm(item, draft)}
    </div>
  </article>`;
  }
  return `<article class="gate attention-item gate-${escapeHtml(item.kind)}" aria-label="${escapeHtml(GATE_LABELS[item.kind] ?? "Question")}">
    <header class="gate-head">
      ${gateHead(item, ctx, item.askedAt)}
      ${gateHolder(item)}
      ${gateSteps(item)}
    </header>
    <div class="gate-body">
      <div class="gate-main">
        ${gateContext(item, ctx)}
        ${gateGuidance(item)}
        ${evidence(item)}
        ${inspectList(item, ctx)}
        ${item.stale ? `<p class="notice">Every file this question refers to is gone, so it may no longer apply. The agent that asked it withdraws it when it does not.</p>` : ""}
      </div>
      ${item.unavailable ? unavailableAnswer(item) : answerForm(item, draft)}
    </div>
  </article>`;
}

function given(item) {
  const negative = item.answer.choice === "request-changes";
  return `${badge(choiceLabel(item, item.answer.choice), negative ? "danger" : "success")}${item.answer.note ? ` <span>${escapeHtml(item.answer.note)}</span>` : ""}`;
}

// A detail that is not an open gate: its head, a heading, and what the page knows of it.
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
    body: `<p class="gate-given">${given(item)}</p><p class="attention-footnote muted">An agent that is waiting for these answers resumes on its own shortly after your last answer. Any other agent receives them with your next message in its conversation, even a short one such as “go”.</p>`
  });
}

// A closed question shows the browser answer, or the reason the agent gave when it resolved the question without one.
function closedDetail(item, ctx) {
  const outcome = item.answer ? given(item) : badge("Closed by the agent");
  return detailSheet({
    className: `is-closed gate-${escapeHtml(item.kind)}`,
    head: `${kindChip(item)}<span class="attention-where">${location(item, ctx)}</span>${when(item.closedAt, "attention-time gate-time")}`,
    title: escapeHtml(item.question),
    body: `<p class="gate-given">${outcome}</p>${item.reason ? `<p class="muted">${escapeHtml(item.reason)}</p>` : ""}`
  });
}

// A refused answer shows beside the form: the server's reason for an action it no longer offers, and a re-render shows the question as it now stands.
export function answerError(error) {
  if (error.code === "action_unavailable" || error.code === "gate_answered") return { message: error.message, rerender: true };
  if (error.code === "unknown_gate") return { message: "The agent already resolved or withdrew this question.", rerender: true };
  if (error.code === "artifact_changed") return { message: "The file changed since this approval was asked, so nothing was recorded. The agent asks again for the current version.", rerender: true };
  if (error.code === "approval_ambiguous") return { message: "Another pending approval holds this question's id, so nothing was recorded. The agent asks again for the file it means.", rerender: true };
  if (error.code === "author_unknown") return { message: "Git names no user for this checkout, so the approval cannot record who gave it. Set one with git config user.name, then answer again.", rerender: false };
  return { message: error.message, rerender: false };
}

function bindAnswers(container, ctx, gates) {
  const drafts = (ctx.state.drafts ??= {});
  for (const form of container.querySelectorAll(".gate-answer")) {
    const id = form.dataset.gate;
    const item = gates.find((gate) => gate.id === id);
    const draft = (drafts[id] ??= { choice: null, note: "" });
    const field = form.querySelector("[data-note]");
    const note = field.control ?? field.querySelector("textarea");
    const failure = form.querySelector(".gate-error");
    const submit = form.querySelector("[data-submit]");
    const hint = form.querySelector(".gate-hint");
    const hintText = hint.querySelector(".gate-hint-text");
    const hintIcon = hint.querySelector("prism-icon");
    const choice = form.querySelector("prism-choice[data-choice]");
    const clear = form.querySelector("[data-clear-choice]");
    note.rows = 3;
    note.maxLength = 4000;
    note.setAttribute("aria-describedby", [note.getAttribute("aria-describedby"), hint.id, failure.id].filter(Boolean).join(" "));
    let sending = false;
    // A change updates the form in place, so focus and the typed note stay where they are.
    const refresh = () => {
      const state = answerState(item, draft);
      const ready = !sending && state.ready && !state.hint;
      field.setAttribute("label", noteLabel(state));
      field.setAttribute("placeholder", state.notePlaceholder);
      field.toggleAttribute("required", state.noteRequired);
      submit.textContent = state.submitLabel;
      submit.setAttribute("variant", state.choice === "request-changes" ? "danger" : "primary");
      submit.toggleAttribute("disabled", sending || !state.ready);
      if (clear) clear.hidden = !draft.choice;
      const text = readyText(item, state);
      if (hintText.textContent !== text) hintText.textContent = text;
      hint.classList.toggle("is-ready", ready);
      hintIcon.hidden = !ready;
    };
    const clearFailure = () => {
      draft.error = null;
      failure.hidden = true;
    };
    choice?.addEventListener("change", () => {
      draft.choice = choice.value || null;
      clearFailure();
      refresh();
    });
    // Clear choice, or choosing the chosen option again, leaves the answer to the note.
    clear?.addEventListener("click", () => {
      choice.clear();
      note.focus();
    });
    note.addEventListener("input", () => {
      draft.note = note.value;
      draft.selection = [note.selectionStart, note.selectionEnd];
      clearFailure();
      refresh();
    });
    note.addEventListener("focus", () => {
      ctx.state.focus = id;
    });
    note.addEventListener("blur", () => {
      if (ctx.state.focus === id) ctx.state.focus = null;
    });
    submit.addEventListener("click", async () => {
      const state = answerState(item, draft);
      if (!state.ready || sending) return;
      sending = true;
      clearFailure();
      refresh();
      try {
        const target = form.hasAttribute("data-approval") ? { approval: true } : { initiative: form.dataset.initiative };
        await ctx.answerGate({ ...target, id, choice: state.choice, note: draft.note });
        delete drafts[id];
        ctx.state.focus = null;
        ctx.showToast("Answer recorded. An agent that is waiting resumes on its own; any other agent sees it with your next message.");
        ctx.rerender();
      } catch (error) {
        // The server stays the backstop: its refusal shows beside the form, and the draft keeps the note through a re-render.
        const refusal = answerError(error);
        draft.error = refusal.message;
        failure.textContent = draft.error;
        failure.hidden = false;
        sending = false;
        refresh();
        if (refusal.rerender) ctx.rerender();
      }
    });
    // The page re-renders when live data changes, so an unsent note and its cursor are restored.
    if (ctx.state.focus === id) {
      note.focus();
      const [start, end] = draft.selection ?? [note.value.length, note.value.length];
      note.setSelectionRange(start, end);
    }
  }
}

// A change's action reads by its own name: the last part of its id in words, such as "Security review" for initiative.securityReview.
function changeLabel(action) {
  const words = String(action ?? "").split(".").pop().replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Change";
}

function changeValue(value) {
  if (value === null || value === undefined) return "none";
  if (typeof value === "object") return Object.entries(value).filter(([, item]) => item !== null && item !== "").map(([key, item]) => `${key}: ${typeof item === "object" ? JSON.stringify(item) : item}`).join(", ") || "none";
  return String(value);
}

// The author is what the applying checkout's Git configuration claims, so the page names it as given and never as verified.
function changeAuthor(by) {
  return by?.name || by?.email || "An unknown person";
}

function changeWhere(entry, ctx) {
  const [kind, rest = ""] = String(entry.target ?? "").split(/:(.*)/s);
  const parts = [];
  if (entry.initiative) parts.push(artifactChip(`initiative:${entry.initiative}`, ctx, entry.initiative));
  if (kind === "index") parts.push(`<code class="recent-change-target" data-code-subject>${escapeHtml(rest)}</code>`);
  if (kind === "gate" && !entry.question) parts.push('<span class="muted">question</span>');
  // A change of a store artifact, such as an approval, names the file in full and its scope, since it belongs to no initiative.
  if (entry.artifact && typeof entry.artifact.path === "string") {
    parts.push(`<code class="recent-change-target" data-code-subject>${escapeHtml(entry.artifact.path)}</code>`, chip(escapeHtml(entry.artifact.scope?.label ?? "workspace")));
  }
  if (kind === "approval") parts.push('<span class="muted">approval</span>');
  return parts.join('<span class="crumb-separator" aria-hidden="true">›</span>');
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// The characters of a comment that Recent changes shows.
const COMMENT_SHOWN = 280;

function changeStep(before, after) {
  return `<span class="recent-change-before">${escapeHtml(before)}</span> <span aria-hidden="true">→</span><span class="sr-only">to</span> <span class="recent-change-after">${escapeHtml(after)}</span>`;
}

// Two object values, such as model names, show only the parts that changed, so a long value does not hide what differs.
function changeValues(entry) {
  if (entry.action === "gate.answer") return escapeHtml(changeValue(entry.after));
  // A comment changes no value, so it shows the line it names and the start of its text, which the file's page shows whole.
  if (entry.action === "artifact.comment" && isObject(entry.after)) {
    const text = String(entry.after.text ?? "");
    return `<span class="recent-change-part">Line ${escapeHtml(String(entry.after.line ?? ""))}: ${escapeHtml(text.length > COMMENT_SHOWN ? `${text.slice(0, COMMENT_SHOWN)}…` : text)}</span>`;
  }
  if (isObject(entry.before) && isObject(entry.after)) {
    const keys = [...new Set([...Object.keys(entry.before), ...Object.keys(entry.after)])].filter((key) => JSON.stringify(entry.before[key] ?? null) !== JSON.stringify(entry.after[key] ?? null));
    if (keys.length) return keys.map((key) => `<span class="recent-change-part">${escapeHtml(key)}: ${changeStep(changeValue(entry.before[key]), changeValue(entry.after[key]))}</span>`).join("; ");
  }
  return changeStep(changeValue(entry.before), changeValue(entry.after));
}

// The author's address shows beside a name, since the page has no tooltip for plain text.
function authorText(by) {
  const name = changeAuthor(by);
  return by?.email && by.email !== name ? `${escapeHtml(name)} <span class="muted">(${escapeHtml(by.email)})</span>` : escapeHtml(name);
}

export function changeHtml(entry, ctx) {
  const values = changeValues(entry);
  return `<li class="recent-change" data-change="${escapeHtml(entry.id)}">
    <div class="attention-head">${badge(changeLabel(entry.action))}<span class="attention-where">${changeWhere(entry, ctx)}</span>${when(entry.at)}</div>
    ${entry.question ? `<p class="recent-change-question">${escapeHtml(entry.question)}</p>` : ""}
    <p class="recent-change-values">${values}</p>
    <p class="recent-change-by muted"><span>${authorText(entry.by)}</span> · <span>${escapeHtml(entry.by?.checkout ?? "an unknown checkout")}</span></p>
  </li>`;
}

const RECENT_LIMIT = 20;

// A change applied while the page is open joins the top of the list at once; the next load brings the list as the records hold it.
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

// A note in Needs you: its row in the list and its detail beside it.
function noteEntry(item, ctx) {
  const roadmapLink = artifactChip("roadmap", ctx, "Roadmap");
  const describe = {
    "pending-note": () => ({ kind: "Pending item", icon: "document", tone: "neutral", title: escapeHtml(item.text), text: "", where: location(item, ctx), meta: item.initiative?.title ?? "" }),
    unlisted: () => ({ kind: "Needs prioritization", icon: "roadmap", tone: "warning", title: `${escapeHtml(item.initiative.title ?? item.initiative.id)} is not on the roadmap`, text: `${escapeHtml(item.initiative.title ?? item.initiative.id)} has an initiative record but no roadmap entry. Ask the agent to run <code>roadmap</code>.`, where: location(item, ctx), meta: "Needs prioritization" }),
    "open-question": () => ({ kind: "Roadmap question", icon: "roadmap", tone: "neutral", title: escapeHtml(item.text), text: "", where: roadmapLink, meta: "Open question on the roadmap" }),
    "roadmap-missing": () => ({ kind: "No roadmap", icon: "warning", tone: "warning", title: "No roadmap", text: "No roadmap record exists yet. Ask the agent to run <code>setup</code>.", where: "", meta: "Roadmap" }),
    "roadmap-problem": () => ({ kind: "Roadmap problem", icon: "warning", tone: "danger", title: "The roadmap has a problem", text: messageHtml(item.message), where: roadmapLink, meta: "Roadmap problem" }),
    config: () => ({ kind: "Workflow settings", icon: "warning", tone: "warning", title: "Check the workflow settings", text: messageHtml(item.message), where: "", meta: "Workflow settings" })
  }[item.type];
  const content = describe ? describe() : { kind: item.type, icon: "info", tone: "neutral", title: escapeHtml(item.type), text: "", where: "", meta: "" };
  return {
    row: { icon: content.icon, tone: content.tone, title: content.title, meta: escapeHtml(content.meta) },
    detail: detailSheet({ className: `note-${escapeHtml(item.type)}`, head: `${badge(content.kind)}<span class="attention-where">${content.where}</span>`, title: content.title, body: content.text ? `<p class="attention-note">${content.text}</p>` : "" })
  };
}

function recordName(path, ctx) {
  const named = ctx.describe?.(path) ?? recordLabel(path);
  return named.code ? null : named.kind;
}

// Agent-side state in Watch: its row and its detail.
function watchEntry(item, ctx) {
  const where = location(item, ctx);
  const slice = item.slice?.title ?? item.initiative?.title ?? "";
  const describe = {
    blocked: () => ({ icon: "warning", tone: "danger", title: "The slice is blocked", meta: slice, head: badge("blocked", "danger"), text: "The slice is blocked." }),
    findings: () => ({ icon: "flask", tone: item.blocking ? "danger" : "warning", title: item.blocking ? plural(item.blocking, "blocking finding") : plural(item.unresolved, "open finding"), meta: `Review ledger · ${slice}`, head: item.blocking ? badge(plural(item.blocking, "blocking finding"), "danger") : badge(plural(item.unresolved, "open finding"), "warning"), text: artifactChip(item.path, ctx, "Open the findings board") }),
    active: () => ({ icon: "agent", tone: "info", title: `${escapeHtml(item.workers.join(", ") || "An agent")} ${item.activity === "design" ? "is designing" : "is implementing"}`, meta: `${slice}${item.label ? ` · ${item.label}` : ""}`, head: badge("active", "info"), text: `${escapeHtml(item.activity)}${item.label ? ` · ${escapeHtml(item.label)}` : ""} · ${escapeHtml(item.workers.join(", "))}` }),
    "failed-verification": () => ({ icon: "flask", tone: "danger", title: `${escapeHtml(slice)} failed verification`, meta: failedReason(item), head: badge("failed verification", "danger"), text: `${escapeHtml(failedReason(item))}${item.finishedAt ? ` · ${when(item.finishedAt)}` : ""}` }),
    "ready-to-ship": () => ({ icon: "check-circle", tone: "success", title: "Ready to ship", meta: slice, head: badge("ready to ship", "success"), text: "Every slice is done; the orchestrator records the ship decision at graduation." }),
    "record-problem": () => ({ icon: "warning", tone: "danger", title: "A record has a problem", meta: recordName(item.path, ctx) ?? "Record", head: badge("record problem", "danger"), text: `${artifactChip(item.path, ctx, recordName(item.path, ctx) ?? undefined)} ${escapeHtml(item.message)}` })
  }[item.type];
  const row = describe ? describe() : { icon: "info", tone: "neutral", title: escapeHtml(item.type), meta: "", head: badge(item.type), text: "" };
  return {
    row: { icon: row.icon, tone: row.tone, title: row.title, meta: escapeHtml(row.meta) },
    detail: detailSheet({ className: `watch-${escapeHtml(item.type)}`, head: `${row.head}<span class="attention-where">${where}</span>`, title: row.title, body: row.text ? `<p class="watch-detail">${row.text}</p>` : "" })
  };
}

// A failed verification run's reason in words, with the number of failing tests when the run names them.
const RUN_REASONS = {
  command_failed: "The tests failed",
  timed_out: "The tests timed out",
  cancelled: "The run was cancelled",
  tracked_files_changed: "The run changed tracked files",
  frozen_tests_changed: "The frozen tests changed",
  start_content_missing: "The slice's start content is missing",
  component_boundary: "The change crossed its component's boundary"
};

export function failedReason(item) {
  const words = RUN_REASONS[item.reason] ?? "The run failed";
  return Number.isInteger(item.failingCount) && item.failingCount > 0 ? `${words}, ${plural(item.failingCount, "test")} failed` : words;
}

// A claim in the Watch group: who holds which slice for what, and how long it has left or since when it lapsed; it offers no action.
function claimEntry(claim, ctx) {
  const where = location({ initiative: claim.initiative, slice: { slug: claim.slug, title: claim.sliceTitle } }, ctx);
  const left = timeLeft(claim.expiresAt);
  const expired = left.expired || claim.expired;
  const doing = claim.activity === "design" ? "is designing" : "is implementing";
  const title = expired ? `${escapeHtml(claim.label)}'s claim expired` : `${escapeHtml(claim.label)} ${doing}`;
  return {
    row: { start: `<prism-claim slot="start" variant="avatar"${claimAttributes(claim)}></prism-claim>`, title, meta: `${escapeHtml(claim.sliceTitle)}${left.text ? ` · ${liveTime(claim.expiresAt, { format: "left" })}` : ""}${expired ? " · free to take" : ""}`, end: expired ? shortTime(claim.expiresAt) : "live" },
    detail: detailSheet({ className: "watch-claim", head: `${badge(expired ? "claim expired" : "working", expired ? "warning" : "info")}<span class="attention-where">${where}</span>`, title, body: `<p class="watch-detail"><prism-claim variant="strip"${claimAttributes(claim)}></prism-claim></p>` })
  };
}

function inboxRow(key, row) {
  return `<prism-inbox-item value="${escapeHtml(key)}"${row.icon && !row.start ? ` icon="${row.icon}" tone="${row.tone ?? "neutral"}"` : ""}${row.unread ? " unread" : ""}>${row.start ?? ""}${row.title}${row.meta ? `<span slot="description">${row.meta}</span>` : ""}${row.end ? `<span slot="end">${row.end}</span>` : ""}</prism-inbox-item>`;
}

// A group of the list: a label with its count and the rows to pick from.
function group(id, label, entries, { count = entries.length, tone = "neutral", note = "" } = {}) {
  if (!entries.length) return "";
  return `<section class="attention-group" aria-labelledby="attention-group-${id}">
    <h2 class="attention-group-label" id="attention-group-${id}"><span>${escapeHtml(label)}</span> <prism-badge tone="${tone}">${count}</prism-badge></h2>
    ${note ? `<p class="attention-footnote attention-group-note muted">${escapeHtml(note)}</p>` : ""}
    <prism-inbox label="${escapeHtml(label)}" data-inbox>${entries.map(({ key, row }) => inboxRow(key, row)).join("")}</prism-inbox>
  </section>`;
}

// A question chosen on a filtered page opens Everything with that question picked, so it can be answered there.
let pendingSelection = null;

// The filter's name and count above its items, with the way back to everything, in the page head.
function filterLine(container, text, ctx) {
  setPageSub(container, pageSub(escapeHtml(text), { end: '<a href="./review?artifact=attention" data-artifact="attention">Show everything</a>' }), ctx);
}

const where = (item) => [item.initiative?.title, item.slice?.title].filter(Boolean);

// One item of a filtered page: its kind tile, its title as a link to where it is handled, where it belongs and what it is, its kind, and its time.
function filteredItem({ kind, item }, ctx) {
  const slice = item.slice?.title ?? "";
  const sliceRef = item.slice && item.initiative ? `slice:${item.initiative.id}/${item.slice.slug}` : null;
  const initiativeRef = item.initiative ? `initiative:${item.initiative.id}` : null;
  const plain = (...parts) => parts.filter(Boolean).map(escapeHtml).join(" · ");
  const look = {
    gate: () => ({ icon: KIND_LOOK[item.kind]?.icon ?? "question", tone: KIND_LOOK[item.kind]?.tone ?? "info", title: escapeHtml(item.question), ref: "attention", select: `gate:${item.id}`, sub: plain(...where(item), GATE_LABELS[item.kind] ?? item.kind), chip: ["Question", "accent"], at: item.askedAt, action: "Answer" }),
    "pending-note": () => ({ icon: "document", tone: "neutral", title: escapeHtml(item.text), ref: initiativeRef, sub: plain(item.initiative?.title, "pending item"), chip: ["Question", "accent"] }),
    findings: () => ({ icon: "eye", tone: "warning", title: escapeHtml(slice), ref: ctx.hasArtifact(item.path) ? item.path : sliceRef, sub: plain(item.initiative?.title, item.blocking ? plural(item.blocking, "blocking finding") : plural(item.unresolved, "open finding")), chip: ["Finding", "warning"] }),
    "failed-verification": () => ({ icon: "flask", tone: "danger", title: `${escapeHtml(slice)} failed verification`, ref: sliceRef, sub: plain(item.initiative?.title, failedReason(item)), chip: ["Failed verification", "danger"], at: item.finishedAt }),
    blocked: () => ({ icon: "warning", tone: "danger", title: `${escapeHtml(slice)} is blocked`, ref: sliceRef, sub: plain(item.initiative?.title, "blocked slice"), chip: ["Blocked", "danger"] }),
    "ready-to-ship": () => ({ icon: "check-circle", tone: "success", title: `${escapeHtml(item.initiative.title)} is ready to ship`, ref: initiativeRef, sub: "Every slice is done", chip: ["Ready to ship", "success"] }),
    "record-problem": () => ({ icon: "warning", tone: "danger", title: `${escapeHtml(recordName(item.path, ctx) ?? "A record")} has a problem`, ref: ctx.hasArtifact(item.path) ? item.path : initiativeRef, sub: [escapeHtml(item.initiative?.title ?? ""), messageHtml(item.message ?? "")].filter(Boolean).join(" · "), chip: ["Problem", "danger"] }),
    unlisted: () => ({ icon: "roadmap", tone: "warning", title: `${escapeHtml(item.initiative.title)} is not on the roadmap`, ref: initiativeRef, sub: "It has an initiative record but no roadmap entry", chip: ["Problem", "warning"] }),
    "open-question": () => ({ icon: "roadmap", tone: "neutral", title: escapeHtml(item.text), ref: "roadmap", sub: "Open question on the roadmap", chip: ["Problem", "warning"] }),
    "roadmap-missing": () => ({ icon: "warning", tone: "warning", title: "No roadmap", ref: null, sub: "No roadmap record exists yet; ask the agent to run setup", chip: ["Problem", "warning"] }),
    "roadmap-problem": () => ({ icon: "warning", tone: "danger", title: "The roadmap has a problem", ref: "roadmap", sub: messageHtml(item.message ?? ""), chip: ["Problem", "danger"] }),
    config: () => ({ icon: "warning", tone: "warning", title: "Check the workflow settings", ref: null, sub: messageHtml(item.message ?? ""), chip: ["Problem", "warning"] })
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

// Attention filtered to one kind or one initiative: only its items, as rows that open where each is handled.
function renderFiltered(container, filter, ctx) {
  filterLine(container, `${filter.label} · ${filter.items.length} of ${filter.total} ${filter.total === 1 ? "item" : "items"}`, ctx);
  container.innerHTML = filter.items.length
    ? `<div class="prism-rows" role="list" aria-label="${escapeHtml(filter.label)}">${filter.items.map((entry) => filteredItem(entry, ctx)).join("")}</div>`
    : `<div class="attention-nothing">${emptyState("Nothing here waits on you", `No item of ${filter.label} needs you now.`)}</div>`;
  bindSelection(container);
  bindLinks(container, ctx);
}

// The questions answered or closed in the last 7 days, newest first, each with where it belongs and the answer or the reason it was closed.
function renderAnswered(container, answered, ctx) {
  filterLine(container, `Answered in the last 7 days · ${plural(answered.length, "question")}`, ctx);
  if (!answered.length) {
    container.innerHTML = `<div class="attention-nothing">${emptyState("Nothing answered this week", "No question was answered or closed in the last 7 days.")}</div>`;
    return;
  }
  container.innerHTML = `<div class="prism-rows" role="list" aria-label="Answered in the last 7 days">${answered.map((item) => {
    const place = [item.initiative ? artifactLink(`initiative:${item.initiative.id}`, ctx, item.initiative.title) : "", item.slice && item.initiative ? artifactLink(`slice:${item.initiative.id}/${item.slice.slug}`, ctx, item.slice.title) : ""].filter(Boolean).join(" · ");
    const outcome = item.answer ? given(item) : `${badge("Closed by the agent")}${item.reason ? ` <span>${escapeHtml(item.reason)}</span>` : ""}`;
    const tone = item.answer ? (item.answer.choice === "request-changes" ? "danger" : "success") : "neutral";
    return `<prism-row wrap icon="${item.answer ? "check-circle" : "close"}" tone="${tone}">${escapeHtml(item.question)}${place ? `<span slot="description">${place}</span>` : ""}<span slot="detail">${outcome}</span><prism-chip slot="kind" tone="${item.answer ? "success" : "neutral"}">${item.answer ? "Answered" : "Closed"}</prism-chip>${liveTime(item.at, { format: "short", slot: "time" })}</prism-row>`;
  }).join("")}</div>`;
  bindLinks(container, ctx);
}

export function render(container, entity, ctx) {
  if (entity.data.filter) return renderFiltered(container, entity.data.filter, ctx);
  if (entity.ref === "attention:answered") return renderAnswered(container, entity.data.answered ?? [], ctx);
  const data = entity.data;
  if (pendingSelection) {
    ctx.state.selected = pendingSelection;
    ctx.state.pane = "detail";
    pendingSelection = null;
  }
  const drafts = (ctx.state.drafts ??= {});
  const answered = data.answered ?? [];
  const earlier = data.earlier ?? [];
  const recent = data.recentChanges ?? [];
  const claims = data.claims ?? [];
  const gates = data.needsYou.filter((item) => item.type === "gate");
  const notes = data.needsYou.filter((item) => item.type !== "gate");
  const watched = data.watch.length + claims.length;

  const needs = [
    ...gates.map((item) => ({
      key: `gate:${item.id}`,
      row: { icon: KIND_LOOK[item.kind]?.icon ?? "question", tone: KIND_LOOK[item.kind]?.tone ?? "neutral", unread: true, title: escapeHtml(item.question), meta: escapeHtml([GATE_LABELS[item.kind] ?? item.kind, liveHolder(item) ? `${item.claim.label} is waiting on your answer` : item.slice?.title ?? item.initiative?.title ?? item.artifact?.path].filter(Boolean).join(" · ")), end: shortTime(item.askedAt) },
      detail: gateDetail(item, ctx, drafts[item.id] ?? { choice: null, note: "" })
    })),
    ...notes.map((item, index) => ({ key: `note:${index}`, ...noteEntry(item, ctx) }))
  ];
  // A shipped initiative's open questions can no longer be answered, so they list apart from Needs you and raise no count.
  const shippedRows = (data.shippedGates ?? []).map((item) => ({
    key: `shipped:${item.id}`,
    row: { icon: KIND_LOOK[item.kind]?.icon ?? "question", tone: "neutral", title: escapeHtml(item.question), meta: escapeHtml([GATE_LABELS[item.kind] ?? item.kind, "Cannot be answered", item.slice?.title ?? item.initiative?.title ?? item.artifact?.path].filter(Boolean).join(" · ")), end: shortTime(item.askedAt) },
    detail: gateDetail(item, ctx, {})
  }));
  const waiting = answered.map((item) => ({
    key: `answered:${item.id}`,
    row: { icon: "check", tone: "success", title: escapeHtml(item.question), meta: escapeHtml(`${choiceLabel(item, item.answer.choice)} · waiting for the agent`), end: shortTime(item.answer.answeredAt) },
    detail: answeredDetail(item, ctx)
  }));
  const watch = [
    ...data.watch.map((item, index) => ({ key: `watch:${index}`, ...watchEntry(item, ctx) })),
    ...claims.map((claim, index) => ({ key: `claim:${index}`, ...claimEntry(claim, ctx) }))
  ];
  const closed = earlier.map((item) => ({
    key: `closed:${item.id}`,
    row: { icon: KIND_LOOK[item.kind]?.icon ?? "question", tone: "neutral", title: escapeHtml(item.question), meta: escapeHtml([GATE_LABELS[item.kind] ?? item.kind, item.answer ? choiceLabel(item, item.answer.choice) : "Closed by the agent"].join(" · ")), end: shortTime(item.closedAt) },
    detail: closedDetail(item, ctx)
  }));
  const history = [{
    key: "recent",
    row: { icon: "clock", tone: "neutral", title: "Recent changes", meta: escapeHtml(recent.length ? `${plural(recent.length, "change")} from the review app` : "No changes from the review app yet"), end: shortTime(recent[0]?.at) },
    detail: detailSheet({ className: "recent-changes-sheet", head: badge("From the review app, newest first"), title: "Recent changes", body: `<div data-recent-changes>${recent.length ? `<ul class="recent-changes">${recent.map((entry) => changeHtml(entry, ctx)).join("")}</ul>` : emptyState("No changes yet", "No one changed settings, answered a question, or rebuilt an index from the review app yet.")}</div>` })
  }];
  const all = [...needs, ...shippedRows, ...waiting, ...watch, ...closed, ...history];
  if (!all.some((entry) => entry.key === ctx.state.selected)) ctx.state.selected = all[0].key;
  ctx.state.pane ??= "detail";
  const selected = ctx.state.selected;

  container.innerHTML = `
    <div class="attention-inbox" data-pane="${ctx.state.pane}">
      <div class="attention-list" aria-label="Items that need you">
        ${needs.length ? group("needs", "Needs you", needs, { tone: "accent" }) : `<div class="attention-nothing">${emptyState("Nothing is waiting on you", "Questions an agent asks during an orchestrated run appear here.")}</div>`}
        ${group("shipped", "Shipped history", shippedRows, { note: "These questions were left open when their initiative shipped, so they can no longer be answered." })}
        ${group("answered", "Answered", waiting)}
        ${group("watch", "Watch", watch)}
        ${closed.length ? `<prism-disclosure class="attention-earlier" summary="${escapeHtml(`Earlier questions · ${closed.length}`)}"${closed.some((entry) => entry.key === selected) || ctx.state.earlierOpen ? " open" : ""}><prism-inbox label="Earlier questions" data-inbox>${closed.map(({ key, row }) => inboxRow(key, row)).join("")}</prism-inbox></prism-disclosure>` : ""}
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

  // The page head carries the summary, beside the title, as figures that read on one line.
  const head = container.parentElement?.querySelector(".artifact-header");
  if (head) {
    head.querySelector(".attention-stats")?.remove();
    head.insertAdjacentHTML("beforeend", `<div class="attention-stats">
      ${stat(`${gates.length === 1 ? "question waits" : "questions wait"} on you`, String(gates.length), { tone: gates.length ? "accent" : "success", attributes: ' layout="inline"' })}
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
      // On a phone the list and the detail take turns, so picking an item shows its detail.
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
  bindAnswers(container, ctx, gates);
  // A change applied while the page is open names its question from the questions the page shows.
  const questions = new Map([...gates, ...(data.shippedGates ?? []), ...answered, ...earlier].filter((item) => item.initiative?.id).map((item) => [`gate:${item.initiative.id}/${item.id}`, item.question]));
  followChanges(container, ctx, questions);
  container.querySelector("[data-notify]")?.addEventListener("click", () => {
    void Notification.requestPermission().finally(() => ctx.rerender());
  });
}
