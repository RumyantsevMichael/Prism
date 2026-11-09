import { artifactChip, badge, bindLinks, card, chip, emptyState, escapeHtml, keyValues, plural, stat, summaryPanel } from "./util.js";
import { recordKind, recordLabel } from "./entities.js";
import { claimAttributes } from "./claims.js";
import { isExpired } from "./claim-index.js";
import { notifyControl } from "./attention-signal.js";

const GATE_LABELS = {
  "visual-review": "Visual review",
  correctness: "Correctness confirmation",
  decision: "Decision",
  assistance: "Action needed",
  approval: "Approval"
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
  if (item.kind === "approval" && item.artifact) return artifactChip(item.artifact.path, ctx, item.artifact.path.split("/").pop());
  const parts = [];
  if (item.initiative) parts.push(artifactChip(`initiative:${item.initiative.id}`, ctx, item.initiative.title));
  if (item.slice) parts.push(artifactChip(`slice:${item.initiative.id}/${item.slice.slug}`, ctx, item.slice.title));
  return parts.join('<span class="crumb-separator" aria-hidden="true">›</span>');
}

const REVIEW_KINDS = new Set(["visual-review", "correctness", "approval"]);

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

const KIND_TONES = { "visual-review": "accent", correctness: "accent", decision: "info", assistance: "warning", approval: "accent" };

function when(time) {
  return `<time class="attention-time" datetime="${escapeHtml(time)}">${escapeHtml(ago(time))}</time>`;
}

function gateHead(item, ctx, time) {
  return `<div class="attention-head">${badge(GATE_LABELS[item.kind] ?? item.kind, KIND_TONES[item.kind] ?? "neutral")}<span class="attention-where">${location(item, ctx)}</span>${when(time)}</div>
    <h3 class="attention-question">${escapeHtml(item.question)}</h3>`;
}

// Whose work resumes once the gate is answered: the agent whose live claim holds the slice.
function gateHolder(item) {
  const claim = item.claim;
  if (!claim || typeof claim.label !== "string" || isExpired(claim)) return "";
  return `<p class="gate-holder"><prism-claim variant="avatar"${claimAttributes(claim)}></prism-claim><span><strong>${escapeHtml(claim.label)}</strong> is waiting on your answer.</span></p>`;
}

// The situation the agent wrote for a person who has not followed the run, rendered as Markdown where the page can.
function gateContext(item, ctx) {
  if (!item.context) return "";
  const body = ctx.renderMarkdown ? ctx.renderMarkdown(item.context) : `<p class="gate-context-plain">${escapeHtml(item.context)}</p>`;
  return `<div class="gate-context">${body}</div>`;
}

// The agent's recommendation, so the choice reads without the conversation; each option's consequence shows with the option itself.
function gateGuidance(item) {
  const recommended = item.recommended ?? null;
  const options = item.kind === "decision" ? (item.options ?? []) : [];
  const pick = recommended?.option ? options.find((option) => option.id === recommended.option) : null;
  if (!recommended?.reason) return "";
  return `<p class="gate-recommendation">${badge("Recommended", "accent")}<span>${pick ? `<strong>${escapeHtml(pick.label)}</strong>: ` : ""}${escapeHtml(recommended.reason)}</span></p>`;
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

function inspectList(item, ctx) {
  const available = item.artifacts.filter((artifact) => artifact.available);
  const missing = item.artifacts.filter((artifact) => !artifact.available);
  const chips = available.map((artifact) => {
    const { label, code } = inspectLabel(artifact, ctx);
    return `<li>${code ? `<span data-code-subject>${artifactChip(artifact.path, ctx)}</span>` : artifactChip(artifact.path, ctx, label)}</li>`;
  }).join("");
  const gone = missing.map((artifact) => {
    const { label, code } = inspectLabel(artifact, ctx);
    return `<li${code ? " data-code-subject" : ""}>${chip(escapeHtml(label), { tone: "warning" })}</li>`;
  }).join("");
  return `${chips ? `<div class="gate-inspect"><p class="label-caps">Inspect</p><ul class="chip-row">${chips}</ul></div>` : ""}${gone ? `<div class="gate-inspect"><p class="label-caps">Not found</p><ul class="chip-row">${gone}</ul></div>` : ""}`;
}

function answerForm(item, draft) {
  const options = choices(item);
  const state = answerState(item, draft);
  const key = escapeHtml(item.id);
  const consequences = new Map((item.kind === "decision" ? item.options ?? [] : []).map((option) => [option.id, option.consequence]));
  const optional = !REVIEW_KINDS.has(item.kind) && options.length > 0;
  const choice = options.length
    ? `<div class="gate-choices"><prism-choice label="Your answer" data-choice${state.choice ? ` value="${escapeHtml(state.choice)}"` : ""}>${options.map(([id, label]) => `<prism-choice-option value="${escapeHtml(id)}"${id === "request-changes" ? ' tone="danger"' : ""}>${escapeHtml(label)}${id === item.recommended?.option ? ` ${badge("Recommended", "accent")}` : ""}${consequences.get(id) ? `<span slot="detail">${escapeHtml(consequences.get(id))}</span>` : ""}</prism-choice-option>`).join("")}</prism-choice>${optional ? `<prism-button size="sm" variant="ghost" data-clear-choice${state.choice ? "" : " disabled"}>Clear the choice</prism-button>` : ""}</div>`
    : "";
  // An approval gate is the target approval:<id> of the review app's actions, every other gate the target gate:<initiative>/<id>.
  const target = item.kind === "approval" ? " data-approval" : ` data-initiative="${escapeHtml(item.initiative.id)}"`;
  return `<div class="gate-answer" data-gate="${key}"${target}>
    ${choice}
    <prism-field class="gate-note" type="textarea" data-note label="${escapeHtml(state.noteLabel)}" hint="${state.noteRequired ? "Required" : "Optional"}" placeholder="${escapeHtml(state.notePlaceholder)}"${state.noteRequired ? " required" : ""} value="${escapeHtml(draft.note ?? "")}"></prism-field>
    <div class="gate-actions"><prism-button variant="${state.choice === "request-changes" ? "danger" : "primary"}" data-submit${state.ready ? "" : " disabled"}>${escapeHtml(state.submitLabel)}</prism-button><p class="gate-hint" id="gate-hint-${key}" aria-live="polite">${escapeHtml(state.hint)}</p></div>
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

function gateCard(item, ctx, draft) {
  if (item.kind === "approval") {
    return `<li class="attention-item gate-approval"><article class="gate" aria-label="${escapeHtml(GATE_LABELS.approval)}">
    ${gateHead(item, ctx, item.askedAt)}
    ${approvalSubject(item)}
    ${gateContext(item, ctx)}
    ${answerForm(item, draft)}
  </article></li>`;
  }
  return `<li class="attention-item gate-${escapeHtml(item.kind)}"><article class="gate" aria-label="${escapeHtml(GATE_LABELS[item.kind] ?? "Question")}">
    ${gateHead(item, ctx, item.askedAt)}
    ${gateHolder(item)}
    ${gateContext(item, ctx)}
    ${gateGuidance(item)}
    ${inspectList(item, ctx)}
    ${item.stale ? `<p class="notice">Every file this question refers to is gone, so it may no longer apply. The agent that asked it withdraws it when it does not.</p>` : ""}
    ${answerForm(item, draft)}
  </article></li>`;
}

function given(item) {
  const negative = item.answer.choice === "request-changes";
  return `${badge(choiceLabel(item, item.answer.choice), negative ? "danger" : "success")}${item.answer.note ? ` <span>${escapeHtml(item.answer.note)}</span>` : ""}`;
}

function answeredCard(item, ctx) {
  return `<li class="attention-item is-answered gate-${escapeHtml(item.kind)}">
    ${gateHead(item, ctx, item.answer.answeredAt)}
    <p class="gate-given">${given(item)}</p>
  </li>`;
}

// A closed question shows the browser answer, or the reason the agent gave when it resolved the question without one.
function closedCard(item, ctx) {
  const outcome = item.answer ? given(item) : badge("Closed by the agent");
  return `<li class="attention-item is-closed gate-${escapeHtml(item.kind)}">
    ${gateHead(item, ctx, item.closedAt)}
    <p class="gate-given">${outcome}</p>
    ${item.reason ? `<p class="muted">${escapeHtml(item.reason)}</p>` : ""}
  </li>`;
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
    const choice = form.querySelector("prism-choice[data-choice]");
    const clear = form.querySelector("[data-clear-choice]");
    note.rows = 2;
    note.maxLength = 4000;
    note.setAttribute("aria-describedby", [note.getAttribute("aria-describedby"), hint.id, failure.id].filter(Boolean).join(" "));
    let sending = false;
    // A change updates the form in place, so focus and the typed note stay where they are.
    const refresh = () => {
      const state = answerState(item, draft);
      field.setAttribute("label", state.noteLabel);
      field.setAttribute("hint", state.noteRequired ? "Required" : "Optional");
      field.setAttribute("placeholder", state.notePlaceholder);
      field.toggleAttribute("required", state.noteRequired);
      submit.textContent = state.submitLabel;
      submit.setAttribute("variant", state.choice === "request-changes" ? "danger" : "primary");
      submit.toggleAttribute("disabled", sending || !state.ready);
      clear?.toggleAttribute("disabled", !draft.choice);
      if (hint.textContent !== state.hint) hint.textContent = state.hint;
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
    clear?.addEventListener("click", () => {
      draft.choice = null;
      choice.value = "";
      clearFailure();
      refresh();
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
        ctx.showToast("Answer recorded. An agent waiting in Claude Code resumes on its own; otherwise the agent sees it with your next message.");
        ctx.rerender();
      } catch (error) {
        // The server stays the backstop: its refusal shows beside the form, and the draft keeps the note through a re-render.
        draft.error = {
          gate_answered: "This question already has an answer.",
          unknown_gate: "The agent already resolved or withdrew this question.",
          artifact_changed: "The file changed since this approval was asked, so nothing was recorded. The agent asks again for the current version.",
          approval_ambiguous: "Another pending approval holds this question's id, so nothing was recorded. The agent asks again for the file it means.",
          author_unknown: "Git names no user for this checkout, so the approval cannot record who gave it. Set one with git config user.name, then answer again."
        }[error.code] ?? error.message;
        failure.textContent = draft.error;
        failure.hidden = false;
        sending = false;
        refresh();
        if (["gate_answered", "unknown_gate", "artifact_changed", "approval_ambiguous"].includes(error.code)) ctx.rerender();
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
  if (kind === "gate") parts.push('<span class="muted">question</span>');
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
  return `<li class="attention-item recent-change" data-change="${escapeHtml(entry.id)}">
    <div class="attention-head">${badge(changeLabel(entry.action))}<span class="attention-where">${changeWhere(entry, ctx)}</span>${when(entry.at)}</div>
    <p class="recent-change-values">${values}</p>
    <p class="recent-change-by muted"><span>${authorText(entry.by)}</span> · <span>${escapeHtml(entry.by?.checkout ?? "an unknown checkout")}</span></p>
  </li>`;
}

const RECENT_LIMIT = 20;

// A change applied while the page is open joins the top of the list at once; the next load brings the list as the records hold it.
let following = null;

function followChanges(container, ctx) {
  if (!following) document.addEventListener("prism:action", (event) => following?.(event));
  following = (event) => {
    if (!container.isConnected) return;
    const entry = event.detail;
    const slot = container.querySelector("[data-recent-changes]");
    if (!slot || !entry?.id || slot.querySelector(`[data-change="${CSS.escape(entry.id)}"]`)) return;
    let list = slot.querySelector("ul");
    if (!list) {
      slot.innerHTML = '<ul class="attention-list"></ul>';
      list = slot.querySelector("ul");
    }
    list.insertAdjacentHTML("afterbegin", changeHtml(entry, ctx));
    while (list.children.length > RECENT_LIMIT) list.lastElementChild.remove();
  };
}

function noteCard(item, ctx) {
  const roadmapLink = artifactChip("roadmap", ctx, "Roadmap");
  const describe = {
    "pending-note": () => ["Pending item", escapeHtml(item.text), location(item, ctx)],
    unlisted: () => ["Needs prioritization", `${escapeHtml(item.initiative.id)} has an initiative record but no roadmap entry. Ask the agent to run <code>roadmap</code>.`, location(item, ctx)],
    "open-question": () => ["Roadmap question", escapeHtml(item.text), roadmapLink],
    "roadmap-missing": () => ["No roadmap", "No roadmap record exists yet. Ask the agent to run <code>setup</code>.", ""],
    "roadmap-problem": () => ["Roadmap problem", escapeHtml(item.message), roadmapLink],
    config: () => ["Workflow settings", escapeHtml(item.message), ""]
  }[item.type];
  const content = describe ? describe() : [item.type, "", ""];
  return `<li class="attention-item note-${escapeHtml(item.type)}">
    <div class="attention-head">${badge(content[0])}<span class="attention-where">${content[2]}</span></div>
    <p class="attention-note">${content[1]}</p>
  </li>`;
}

function recordName(path, ctx) {
  const named = ctx.describe?.(path) ?? recordLabel(path);
  return named.code ? null : named.kind;
}

function watchRow(item, ctx) {
  const where = location(item, ctx);
  const describe = {
    blocked: () => [badge("blocked", "danger"), "The slice is blocked."],
    findings: () => [item.blocking ? badge(plural(item.blocking, "blocking finding"), "danger") : badge(plural(item.unresolved, "open finding"), "warning"), artifactChip(item.path, ctx, "Open the findings board")],
    active: () => [badge("active", "info"), `${escapeHtml(item.activity)}${item.label ? ` · ${escapeHtml(item.label)}` : ""} · ${escapeHtml(item.workers.join(", "))}`],
    "ready-to-ship": () => [badge("ready to ship", "success"), "Every slice is done; the orchestrator records the ship decision at graduation."],
    "record-problem": () => [badge("record problem", "danger"), `${artifactChip(item.path, ctx, recordName(item.path, ctx) ?? undefined)} ${escapeHtml(item.message)}`]
  }[item.type];
  const row = describe ? describe() : [escapeHtml(item.type), ""];
  return `<li class="watch-row"><span class="watch-what">${row[0]}</span><span class="attention-where">${where}</span><span class="watch-detail">${row[1]}</span></li>`;
}

// A claim in the Watch group: who holds which slice for what, and how long it has left or since when it lapsed; it offers no action.
function claimRow(claim, ctx) {
  const where = location({ initiative: claim.initiative, slice: { slug: claim.slug, title: claim.sliceTitle } }, ctx);
  return `<li class="watch-row watch-claim"><span class="watch-what"><prism-claim variant="inline"${claimAttributes(claim)}></prism-claim></span><span class="attention-where">${where}</span></li>`;
}

export function render(container, entity, ctx) {
  const data = entity.data;
  const drafts = (ctx.state.drafts ??= {});
  const answered = data.answered ?? [];
  const earlier = data.earlier ?? [];
  const recent = data.recentChanges ?? [];
  const claims = data.claims ?? [];
  const gates = data.needsYou.filter((item) => item.type === "gate");
  const notes = data.needsYou.filter((item) => item.type !== "gate");
  const watched = data.watch.length + claims.length;
  container.innerHTML = `
    ${summaryPanel(`<div class="stat-grid">
        ${stat(`${gates.length === 1 ? "question waits" : "questions wait"} on you`, String(gates.length), { tone: gates.length ? "warning" : "success" })}
        ${stat(`other ${notes.length === 1 ? "item needs" : "items need"} you`, String(notes.length))}
        ${stat(`${watched === 1 ? "thing" : "things"} to watch`, String(watched))}
      </div>
      ${notifyControl(typeof Notification === "undefined" ? null : Notification.permission)}`)}
    ${card("Needs you", data.needsYou.length
      ? `<ul class="attention-list">${gates.map((item) => gateCard(item, ctx, drafts[item.id] ?? { choice: null, note: "" })).join("")}${notes.map((item) => noteCard(item, ctx)).join("")}</ul>`
      : emptyState("Nothing is waiting on you", "Questions an agent asks during an orchestrated run appear here."), { eyebrow: "Answer here or in the agent conversation" })}
    <p class="attention-footnote muted">The orchestrator records a question here while it waits on you during an orchestrated run. Direct skill runs, such as ideate or roadmap, still ask only in the conversation.</p>
    ${answered.length ? card("Answered, waiting for the agent", `<ul class="attention-list">${answered.map((item) => answeredCard(item, ctx)).join("")}</ul><p class="attention-footnote muted">An agent waiting in Claude Code resumes on its own shortly after your last answer. Otherwise the agent receives these answers with your next message in the conversation, even a short one such as “go”.</p>`, { eyebrow: plural(answered.length, "answer") }) : ""}
    ${card("Watch", watched
      ? `<ul class="row-list watch-list">${data.watch.map((item) => watchRow(item, ctx)).join("")}${claims.map((claim) => claimRow(claim, ctx)).join("")}</ul>`
      : emptyState("Nothing to watch", "No blocked slices, open findings, claims, or active work."), { eyebrow: "Agent-side state" })}
    ${card("Recent changes", `<div data-recent-changes>${recent.length ? `<ul class="attention-list">${recent.map((entry) => changeHtml(entry, ctx)).join("")}</ul>` : emptyState("No changes yet", "No one changed settings, answered a question, or rebuilt an index from the review app yet.")}</div>`, { eyebrow: "From the review app, newest first" })}
    ${earlier.length ? card("Earlier questions", `<ul class="attention-list">${earlier.map((item) => closedCard(item, ctx)).join("")}</ul>`, { eyebrow: "Most recent first" }) : ""}`;
  bindLinks(container, ctx);
  bindAnswers(container, ctx, gates);
  followChanges(container, ctx);
  container.querySelector("[data-notify]")?.addEventListener("click", () => {
    void Notification.requestPermission().finally(() => ctx.rerender());
  });
}
