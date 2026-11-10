import { artifactChip, bindLinks, card, emptyNote, escapeHtml, plural } from "./util.js";
import { notifyControl } from "./attention-signal.js";

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

const REVIEW_KINDS = new Set(["visual-review", "correctness"]);

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

function gateHead(item, ctx, time) {
  return `<div class="attention-head"><span class="gate-kind">${escapeHtml(GATE_LABELS[item.kind] ?? item.kind)}</span><span class="attention-where">${location(item, ctx)}</span><span class="muted" title="${escapeHtml(time)}">${escapeHtml(ago(time))}</span></div>
    <p class="attention-question">${escapeHtml(item.question)}</p>`;
}

// The situation the agent wrote for a person who has not followed the run, rendered as Markdown where the page can.
function gateContext(item, ctx) {
  if (!item.context) return "";
  const body = ctx.renderMarkdown ? ctx.renderMarkdown(item.context) : `<p class="gate-context-plain">${escapeHtml(item.context)}</p>`;
  return `<div class="gate-context">${body}</div>`;
}

// Each option's consequence and the agent's recommendation, so the choice reads without the conversation.
function gateGuidance(item) {
  const recommended = item.recommended ?? null;
  const options = item.kind === "decision" ? (item.options ?? []) : [];
  const consequences = options.filter((option) => option.consequence);
  const list = consequences.length
    ? `<ul class="gate-consequences">${consequences.map((option) => `<li${option.id === recommended?.option ? ' class="is-recommended"' : ""}><span class="gate-option-label">${escapeHtml(option.label)}</span><span class="gate-consequence">${escapeHtml(option.consequence)}</span></li>`).join("")}</ul>`
    : "";
  const pick = recommended?.option ? options.find((option) => option.id === recommended.option) : null;
  const reason = recommended?.reason
    ? `<p class="gate-recommendation"><span class="gate-tag">Recommended</span> ${pick ? `<span class="gate-option-label">${escapeHtml(pick.label)}</span>: ` : ""}${escapeHtml(recommended.reason)}</p>`
    : "";
  return list || reason ? `<div class="gate-guidance">${list}${reason}</div>` : "";
}

function answerForm(item, draft) {
  const options = choices(item);
  const state = answerState(item, draft);
  const key = escapeHtml(item.id);
  return `<div class="gate-answer" data-gate="${key}" data-initiative="${escapeHtml(item.initiative.id)}">
    ${options.length ? `<div class="gate-choices" role="group" aria-label="Your answer">${options.map(([id, label]) => `<button type="button" class="choice-button${id === "request-changes" ? " is-negative" : id === "approve" ? " is-positive" : ""}${id === item.recommended?.option ? " is-recommended" : ""}" data-choice="${escapeHtml(id)}" aria-pressed="${state.choice === id}"${id === item.recommended?.option ? ' title="Recommended"' : ""}>${escapeHtml(label)}</button>`).join("")}</div>` : ""}
    <label class="gate-note"><span class="gate-note-label"><span data-note-label>${escapeHtml(state.noteLabel)}</span> <span class="gate-note-need${state.noteRequired ? " is-required" : ""}" data-note-need>${state.noteRequired ? "required" : "optional"}</span></span><textarea data-note rows="2" maxlength="4000" placeholder="${escapeHtml(state.notePlaceholder)}" aria-required="${state.noteRequired}">${escapeHtml(draft.note ?? "")}</textarea></label>
    <div class="gate-actions"><button type="button" class="tool-button primary${state.choice === "request-changes" ? " is-negative" : ""}" data-submit aria-describedby="gate-hint-${key} gate-error-${key}"${state.ready ? "" : " disabled"}>${escapeHtml(state.submitLabel)}</button><p class="gate-hint" id="gate-hint-${key}" aria-live="polite">${escapeHtml(state.hint)}</p></div>
    <p class="gate-error" id="gate-error-${key}" role="alert"${draft.error ? "" : " hidden"}>${escapeHtml(draft.error ?? "")}</p>
  </div>`;
}

// A question the server no longer takes an answer to, such as one of a shipped initiative, names why in place of the form.
function unavailableAnswer(item) {
  return `<p class="notice gate-unavailable" role="note"><span class="gate-tag">Cannot be answered</span> ${escapeHtml(item.unavailable)}</p>`;
}

export function gateCard(item, ctx, draft) {
  const available = item.artifacts.filter((artifact) => artifact.available);
  const missing = item.artifacts.filter((artifact) => !artifact.available);
  return `<li class="attention-card gate-${escapeHtml(item.kind)}">
    ${gateHead(item, ctx, item.askedAt)}
    ${gateContext(item, ctx)}
    ${gateGuidance(item)}
    ${available.length ? `<div class="attention-artifacts"><span class="muted">Inspect</span> ${available.map((artifact) => artifactChip(artifact.path, ctx, artifact.path.split("/").pop())).join(" ")}</div>` : ""}
    ${missing.length ? `<p class="muted">Not found: ${missing.map((artifact) => `<code>${escapeHtml(artifact.path)}</code>`).join(" ")}</p>` : ""}
    ${item.stale ? `<p class="notice">Every file this question refers to is gone, so it may no longer apply. The agent that asked it withdraws it when it does not.</p>` : ""}
    ${item.unavailable ? unavailableAnswer(item) : answerForm(item, draft)}
  </li>`;
}

function answeredCard(item, ctx) {
  return `<li class="attention-card is-answered gate-${escapeHtml(item.kind)}">
    ${gateHead(item, ctx, item.answer.answeredAt)}
    <p class="gate-given"><span class="choice-given${item.answer.choice === "request-changes" ? " is-negative" : ""}">${escapeHtml(choiceLabel(item, item.answer.choice))}</span>${item.answer.note ? ` ${escapeHtml(item.answer.note)}` : ""}</p>
  </li>`;
}

// A closed question shows the browser answer, or the reason the agent gave when it resolved the question without one.
function closedCard(item, ctx) {
  const outcome = item.answer
    ? `<span class="choice-given${item.answer.choice === "request-changes" ? " is-negative" : ""}">${escapeHtml(choiceLabel(item, item.answer.choice))}</span>${item.answer.note ? ` ${escapeHtml(item.answer.note)}` : ""}`
    : `<span class="choice-given">Closed by the agent</span>`;
  return `<li class="attention-card is-closed gate-${escapeHtml(item.kind)}">
    ${gateHead(item, ctx, item.closedAt)}
    <p class="gate-given">${outcome}</p>
    ${item.reason ? `<p class="muted">${escapeHtml(item.reason)}</p>` : ""}
  </li>`;
}

// A refused answer shows beside the form: the server's reason for an action it no longer offers, and a re-render shows the question as it now stands.
export function answerError(error) {
  if (error.code === "action_unavailable" || error.code === "gate_answered") return { message: error.message, rerender: true };
  if (error.code === "unknown_gate") return { message: "The agent already resolved or withdrew this question.", rerender: true };
  return { message: error.message, rerender: false };
}

function bindAnswers(container, ctx, gates) {
  const drafts = (ctx.state.drafts ??= {});
  for (const form of container.querySelectorAll(".gate-answer")) {
    const id = form.dataset.gate;
    const item = gates.find((gate) => gate.id === id);
    const draft = (drafts[id] ??= { choice: null, note: "" });
    const note = form.querySelector("[data-note]");
    const failure = form.querySelector(".gate-error");
    const submit = form.querySelector("[data-submit]");
    const hint = form.querySelector(".gate-hint");
    const need = form.querySelector("[data-note-need]");
    let sending = false;
    // A change updates the form in place, so focus and the typed note stay where they are.
    const refresh = () => {
      const state = answerState(item, draft);
      for (const button of form.querySelectorAll("[data-choice]")) button.setAttribute("aria-pressed", String(button.dataset.choice === state.choice));
      form.querySelector("[data-note-label]").textContent = state.noteLabel;
      need.textContent = state.noteRequired ? "required" : "optional";
      need.classList.toggle("is-required", state.noteRequired);
      note.placeholder = state.notePlaceholder;
      note.setAttribute("aria-required", String(state.noteRequired));
      submit.textContent = state.submitLabel;
      submit.classList.toggle("is-negative", state.choice === "request-changes");
      submit.disabled = sending || !state.ready;
      if (hint.textContent !== state.hint) hint.textContent = state.hint;
    };
    const clearFailure = () => {
      draft.error = null;
      failure.hidden = true;
    };
    for (const button of form.querySelectorAll("[data-choice]")) {
      button.addEventListener("click", () => {
        draft.choice = draft.choice === button.dataset.choice ? null : button.dataset.choice;
        clearFailure();
        refresh();
      });
    }
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
        await ctx.answerGate({ initiative: form.dataset.initiative, id, choice: state.choice, note: draft.note });
        delete drafts[id];
        ctx.state.focus = null;
        ctx.showToast("Answer recorded. An agent waiting in Claude Code resumes on its own; otherwise the agent sees it with your next message.");
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
  if (kind === "index") parts.push(`<code class="recent-change-target" title="${escapeHtml(rest)}">${escapeHtml(rest)}</code>`);
  if (kind === "gate") parts.push('<span class="muted">question</span>');
  return parts.join('<span class="crumb-separator" aria-hidden="true">›</span>');
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function changeStep(before, after) {
  return `<span class="recent-change-before">${escapeHtml(before)}</span> <span aria-hidden="true">→</span><span class="sr-only">to</span> <span class="recent-change-after">${escapeHtml(after)}</span>`;
}

// Two object values, such as model names, show only the parts that changed, so a long value does not hide what differs.
function changeValues(entry) {
  if (entry.action === "gate.answer") return escapeHtml(changeValue(entry.after));
  if (isObject(entry.before) && isObject(entry.after)) {
    const keys = [...new Set([...Object.keys(entry.before), ...Object.keys(entry.after)])].filter((key) => JSON.stringify(entry.before[key] ?? null) !== JSON.stringify(entry.after[key] ?? null));
    if (keys.length) return keys.map((key) => `<span class="recent-change-part">${escapeHtml(key)}: ${changeStep(changeValue(entry.before[key]), changeValue(entry.after[key]))}</span>`).join("; ");
  }
  return changeStep(changeValue(entry.before), changeValue(entry.after));
}

export function changeHtml(entry, ctx) {
  const values = changeValues(entry);
  return `<li class="attention-card recent-change" data-change="${escapeHtml(entry.id)}">
    <div class="attention-head"><span class="gate-kind is-note">${escapeHtml(changeLabel(entry.action))}</span><span class="attention-where">${changeWhere(entry, ctx)}</span><span class="muted" title="${escapeHtml(entry.at)}">${escapeHtml(ago(entry.at))}</span></div>
    <p class="recent-change-values">${values}</p>
    <p class="recent-change-by muted"><span title="${escapeHtml(entry.by?.email ?? "")}">${escapeHtml(changeAuthor(entry.by))}</span> · <span title="${escapeHtml(entry.by?.checkout ?? "")}">${escapeHtml(entry.by?.checkout ?? "an unknown checkout")}</span></p>
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
    "roadmap-missing": () => ["No roadmap", `No roadmap record exists at <code>${escapeHtml(item.path)}</code>. Ask the agent to run <code>setup</code>.`, ""],
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
  const drafts = (ctx.state.drafts ??= {});
  const answered = data.answered ?? [];
  const earlier = data.earlier ?? [];
  const recent = data.recentChanges ?? [];
  const gates = data.needsYou.filter((item) => item.type === "gate");
  const notes = data.needsYou.filter((item) => item.type !== "gate");
  const shipped = data.shippedGates ?? [];
  const waiting = gates.length;
  container.innerHTML = `
    <section class="view-card summary-card">
      <div class="stat-row">
        <div class="stat ${waiting ? "is-warn" : "is-good"}"><span class="stat-value">${waiting}</span><span class="stat-label">${waiting === 1 ? "question waits" : "questions wait"} on you</span></div>
        <div class="stat"><span class="stat-value">${notes.length}</span><span class="stat-label">other ${notes.length === 1 ? "item needs" : "items need"} you</span></div>
        <div class="stat"><span class="stat-value">${data.watch.length}</span><span class="stat-label">agent-side ${data.watch.length === 1 ? "signal" : "signals"}</span></div>
      </div>
      ${notifyControl(typeof Notification === "undefined" ? null : Notification.permission)}
    </section>
    ${card("Needs you", data.needsYou.length
      ? `<ul class="attention-list">${gates.map((item) => gateCard(item, ctx, drafts[item.id] ?? { choice: null, note: "" })).join("")}${notes.map((item) => noteCard(item, ctx)).join("")}</ul>`
      : emptyNote("Nothing is waiting on you."), { eyebrow: "Answer here or in the agent conversation" })}
    <p class="attention-footnote muted">The orchestrator records a question here while it waits on you during an orchestrated run. Direct skill runs, such as ideate or roadmap, still ask only in the conversation.</p>
    ${shipped.length ? card("Shipped history", `<p class="shipped-gates-note muted">These questions were left open when their initiative shipped, so they can no longer be answered.</p><ul class="attention-list">${shipped.map((item) => gateCard(item, ctx, {})).join("")}</ul>`, { eyebrow: plural(shipped.length, "question") }) : ""}
    ${answered.length ? card("Answered, waiting for the agent", `<ul class="attention-list">${answered.map((item) => answeredCard(item, ctx)).join("")}</ul><p class="attention-footnote muted">An agent waiting in Claude Code resumes on its own shortly after your last answer. Otherwise the agent receives these answers with your next message in the conversation, even a short one such as “go”.</p>`, { eyebrow: plural(answered.length, "answer") }) : ""}
    ${card("Watch", data.watch.length
      ? `<div class="table-wrap"><table class="data-table attention-watch"><tbody>${data.watch.map((item) => watchRow(item, ctx)).join("")}</tbody></table></div>`
      : emptyNote("No blocked slices, open findings, or active work."), { eyebrow: "Agent-side state" })}
    ${card("Recent changes", `<div data-recent-changes>${recent.length ? `<ul class="attention-list">${recent.map((entry) => changeHtml(entry, ctx)).join("")}</ul>` : emptyNote("No one changed settings, answered a question, or rebuilt an index from the review app yet.")}</div>`, { eyebrow: "From the review app, newest first" })}
    ${earlier.length ? card("Earlier questions", `<ul class="attention-list">${earlier.map((item) => closedCard(item, ctx)).join("")}</ul>`, { eyebrow: "Most recent first" }) : ""}`;
  bindLinks(container, ctx);
  bindAnswers(container, ctx, gates);
  followChanges(container, ctx);
  container.querySelector("[data-notify]")?.addEventListener("click", () => {
    void Notification.requestPermission().finally(() => ctx.rerender());
  });
}
