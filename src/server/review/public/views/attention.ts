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

const GATE_LABELS: Record<string, any> = {
  "visual-review": "Visual review",
  correctness: "Correctness confirmation",
  decision: "Decision",
  assistance: "Action needed",
  approval: "Approval"
};

// The kind of a question as the glyph and tone of its row and the icon of its chip.
const KIND_LOOK: Record<string, any> = {
  "visual-review": { icon: "gate", tone: "accent", chip: "eye" },
  correctness: { icon: "gate", tone: "accent", chip: "check-circle" },
  decision: { icon: "question", tone: "info", chip: "question" },
  assistance: { icon: "warning", tone: "warning", chip: "warning" },
  approval: { icon: "gate", tone: "accent", chip: "check-circle" }
};

// A time in words that keeps itself current: 5 min ago, or for a row's narrow column 5 min or now, or 30 min left.
function liveTime(time: any, { format = "ago", className = "", slot = "" }: any = {}) {
  if (!time) return "";
  return `<prism-time${className ? ` class="${className}"` : ""}${slot ? ` slot="${slot}"` : ""}${format === "ago" ? "" : ` format="${format}"`} datetime="${escapeHtml(time)}"></prism-time>`;
}

const shortTime = (time: any) => liveTime(time, { format: "short" });

function location(item: any, ctx: any) {
  if (item.kind === "approval" && item.artifact) return artifactChip(item.artifact.path, ctx, item.artifact.path.split("/").pop());
  const parts = [];
  if (item.initiative) parts.push(artifactChip(`initiative:${item.initiative.id}`, ctx, item.initiative.title));
  if (item.slice) parts.push(artifactChip(`slice:${item.initiative.id}/${item.slice.slug}`, ctx, item.slice.title));
  return parts.join('<span class="crumb-separator" aria-hidden="true">›</span>');
}

const REVIEW_KINDS = new Set(["visual-review", "correctness", "approval"]);

// An assistance gate has one answer, so its Send button gives it instead of a separate choice.
function choices(item: any) {
  if (REVIEW_KINDS.has(item.kind)) return [["approve", "Approve"], ["request-changes", "Request changes"]];
  if (item.kind === "assistance") return [];
  return (item.options ?? []).map((option: any) => [option.id, option.label]);
}

function choiceLabel(item: any, choice: any) {
  if (item.kind === "assistance" && choice === "done") return "Done";
  return choices(item).find(([id]: any) => id === choice)?.[1] ?? (choice ? choice : "Free answer");
}

const NO_RESULT_PLACEHOLDER = "Answer the run's question, or say what it should do next";

// The words of a gate's answer for the person's draft: the note's label and placeholder, the submit label, and what is missing.
// Whether the answer can be sent comes from the gate.answer listing, which the shared action renderer applies; ready here says the same for the words.
// Nothing is guessed from the note: a review gate needs an explicit choice, and the note is kept whatever the person picks.
export function answerState(item: any, draft: any = {}) {
  const options = choices(item);
  const choice = item.kind === "assistance" ? "done" : options.some(([id]: any) => id === draft.choice) ? draft.choice : null;
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

// The note's label carries whether it is needed, as "Note for the agent · optional" does.
function noteLabel(state: any) {
  const label = state.noteLabel === "Note" ? "Note for the agent" : state.noteLabel;
  return `${label} · ${state.noteRequired ? "required" : "optional"}`;
}

// The line beside Send: once the listing's rules let the answer go, who resumes with it, and otherwise what is missing.
function readyText(item: any, words: any, ready: boolean, fallback: string) {
  if (!ready) return words.hint || fallback;
  return liveHolder(item) ? `Ready to send. ${item.claim.label} resumes shortly after.` : "Ready to send.";
}

function when(time: any, className = "attention-time") {
  return liveTime(time, { className });
}

function liveHolder(item: any) {
  const claim = item.claim;
  return claim && typeof claim.label === "string" && !isExpired(claim) ? claim : null;
}

const PHASES = [["requirements", "Requirements"], ["design", "Design"], ["frozen", "Frozen"], ["build", "Build"], ["review", "Review"], ["shipped", "Shipped"]];
const PHASE_GATES: Record<string, any> = { requirements: "Requirements gate", design: "Design gate", frozen: "Design gate · tests frozen", build: "Build gate", review: "Review gate", shipped: "Ship gate" };

// The phase the gate's slice is in, from the phase facts the review model gives the gate, or null without them.
function gatePhase(item: any) {
  const facts = item.phase;
  if (!facts?.status) return null;
  return currentPhase({ status: facts.status, design: facts.designed ? { review: facts.review } : null });
}

function kindChip(item: any) {
  const look = KIND_LOOK[item.kind];
  return chip(`${look ? `<prism-icon name="${look.chip}" size="xs"></prism-icon> ` : ""}${escapeHtml(GATE_LABELS[item.kind] ?? item.kind)}`);
}

// Only a review question moves its slice to the next phase, so only its card names the phase gate and shows the lifecycle;
// a decision or an action needed while a slice is in design is not a design gate. The tag alone says it; the slice's page shows the whole lifecycle.
const PHASE_KINDS = new Set(["visual-review", "correctness"]);

// The head holds what the question is and where it belongs: its kind, its time, the question, and the work it serves as links,
// so the situation the agent wrote follows it at once; who asked opens the answer beside it.
function gateHead(item: any, ctx: any, time: any) {
  const phase = PHASE_KINDS.has(item.kind) ? gatePhase(item) : null;
  const tag = phase !== null && phase < PHASES.length ? `<prism-phase variant="tag" phase="${PHASES[phase][0]}">${escapeHtml(PHASE_GATES[PHASES[phase][0]])}</prism-phase>` : "";
  return `<div class="gate-chips">${kindChip(item)}${tag}${when(time, "attention-time gate-time")}</div>
    <h3 class="gate-question">${escapeHtml(item.question)}</h3>
    ${item.kind === "approval" ? servedWork(item, ctx) : gateWork(item, ctx)}`;
}

// The work a question belongs to, as a row under the question: the slice with its initiative below it, or the initiative alone.
// Outside a review gate, whose tag already names the phase, the row shows the slice's phase, kept on a phone by stacking it under the text.
function workRow(initiative: string, slice: string | null, phase: number | null, extra = "") {
  const tag = phase !== null && phase < PHASES.length ? `<prism-phase slot="kind" phase="${PHASES[phase][0]}">${escapeHtml(PHASES[phase][1])}</prism-phase>` : "";
  const row = slice
    ? `<prism-row wrap${tag ? " stack" : ""} icon="layers" tone="accent">${slice}<span slot="description">Slice of ${initiative}</span>${tag}</prism-row>`
    : `<prism-row wrap icon="roadmap" tone="neutral">${initiative}<span slot="description">Initiative</span></prism-row>`;
  return `<div class="prism-rows gate-work${extra}" role="list" aria-label="Work">${row}</div>`;
}

function gateWork(item: any, ctx: any) {
  if (!item.initiative) return "";
  const initiative = artifactLink(`initiative:${item.initiative.id}`, ctx, item.initiative.title);
  const slice = item.slice ? artifactLink(`slice:${item.initiative.id}/${item.slice.slug}`, ctx, item.slice.title) : null;
  return workRow(initiative, slice, item.slice && !PHASE_KINDS.has(item.kind) ? gatePhase(item) : null);
}

// The state of the session that asked, as an icon beside its name: the icon's name is the state in words, and its tooltip says what the state means for the answer.
const ASKER_STATES: Record<string, { label: string; icon: string; tone: string; tip: (asker: any) => string }> = {
  waiting: { label: "Waits for your answer", icon: "check-circle", tone: "success", tip: () => "Waits for your answer. This session is waiting on this question and picks up your answer within a minute or so." },
  open: { label: "Open, not waiting", icon: "info", tone: "info", tip: () => "Open, not waiting. This session is open but no longer waits on this question, so it reads your answer only with the next message it gets in its own conversation." },
  "not-running": { label: "Not running", icon: "clock", tone: "neutral", tip: () => "Not running. The session that asked has stopped. It reads your answer the next time it runs, or you can continue the work from here once you have answered." },
  unknown: {
    label: "Prism can't see this session",
    icon: "warning",
    tone: "warning",
    tip: (asker: any) => asker.known && asker.cloud
      ? "Prism can't see this session. It runs in the cloud, so this computer can't tell whether it is still open or waiting. If it is waiting, it picks up your answer within a minute or so. If it was closed, it gets your answer the next time it runs, or when you send it any message in its own conversation. To be sure, open the session and say “go”."
      : `Prism can't see this session. ${asker.reason ?? "This computer can't tell whether it is still open or waiting."} If it is waiting, it picks up your answer within a minute or so. If not, it gets your answer the next time it runs, or when you send it any message in its own conversation.`
  }
};

const askerName = (asker: any) => asker.known ? `${asker.harness ?? "An unnamed harness"} on ${asker.machine ?? "an unnamed machine"}` : "An unknown session";

// An unanswered question whose asker no wait holds and no open session can read can be withdrawn; the shared action renderer draws its
// gate.withdraw listing into this place once the page is drawn, and the server's listing stays the backstop.
function gateWithdraw(item: any) {
  if (item.answer || item.unavailable || !item.asker || item.asker.state === "waiting" || item.asker.state === "open") return "";
  return `<div class="gate-withdraw" data-gate="${escapeHtml(item.id)}" data-withdraw-target="${escapeHtml(answerTarget(item))}"></div>`;
}

// The latest wake this computer sent to the cloud session that asked: when it was sent, or why Claude Code did not deliver it,
// with its words beside the icon, so a long reason wraps under its own first line.
function wakeLine(wake: any) {
  if (wake.delivered) return `<p class="gate-asker-note" data-wake="delivered"><prism-icon name="check-circle" size="xs" tone="ok"></prism-icon><span>Wake sent ${liveTime(wake.at)}</span></p>`;
  return `<p class="gate-asker-note" data-wake="not-delivered"><prism-icon name="warning" size="xs" tone="danger"></prism-icon><span>${escapeHtml(`Wake not delivered: ${wake.reason ?? "Claude Code gave no reason."}`)}</span></p>`;
}

// Who asked the question, where, and whether that session waits, is open, is not running, or is in a state Prism cannot tell, with how to reach an open one,
// at the top of the answer, since the asker is who receives it.
function gateAsker(item: any) {
  const asker = item.asker;
  if (!asker) return "";
  const where = asker.known ? `${asker.checkout ?? "an unnamed checkout"}${asker.cloud ? " · cloud session" : ""}` : "";
  const look = ASKER_STATES[asker.state] ?? ASKER_STATES.unknown;
  const state = `<prism-icon class="gate-asker-state" name="${look.icon}" tone="${look.tone}" size="sm" label="${escapeHtml(look.label)}" tip="${escapeHtml(look.tip(asker))}" tabindex="0"></prism-icon>`;
  const wake = asker.wake ? wakeLine(asker.wake) : "";
  return `<section class="gate-asker" aria-label="Asked by">
    <p class="label-caps">Asked by</p>
    <div class="gate-asker-line"><prism-avatar kind="agent" size="sm" name="${escapeHtml(askerName(asker))}"${asker.state === "waiting" ? " live" : ""}></prism-avatar><div class="gate-asker-text"><p class="gate-asker-who"><strong>${escapeHtml(askerName(asker))}</strong>${state}</p>${where ? `<p class="gate-asker-where">${escapeHtml(where)}</p>` : ""}</div></div>
    ${asker.reach ? `<p class="gate-asker-note">${escapeHtml(asker.reach)}</p>` : ""}${wake}${gateHolder(item)}
  </section>`;
}

// The agent whose live claim holds the slice, for what, and how long the claim has left; it is not always the session that asked, so it is named apart.
function gateHolder(item: any) {
  const claim = liveHolder(item);
  if (!claim) return "";
  const left = timeLeft(claim.expiresAt).text ? `, ${liveTime(claim.expiresAt, { format: "left" })}` : "";
  return `<p class="gate-holder"><prism-claim variant="avatar"${claimAttributes(claim)}></prism-claim><span><strong>${escapeHtml(claim.label)}</strong> holds this slice for ${claim.activity === "design" ? "design" : "implementation"}${left}.</span></p>`;
}

// The asker beside Send, since the answer goes to the session that asked.
function sendTo(item: any) {
  const asker = item.asker;
  if (!asker?.known) return "";
  return `<prism-avatar class="gate-send-to" kind="agent" size="sm" name="${escapeHtml(askerName(asker))}" tip="${escapeHtml(`Your answer goes to ${askerName(asker)}`)}"${asker.state === "waiting" ? " live" : ""}></prism-avatar>`;
}

// The situation the agent wrote for a person who has not followed the run, rendered as Markdown where the page can.
function gateContext(item: any, ctx: any) {
  if (!item.context) return "";
  const body = ctx.renderMarkdown ? ctx.renderMarkdown(item.context) : `<p class="gate-context-plain">${escapeHtml(item.context)}</p>`;
  return `<div class="gate-block"><p class="label-caps">What happened</p><div class="gate-context">${body}</div></div>`;
}

// The agent's recommendation, so the choice reads without the conversation; each option's consequence shows with the option itself.
function gateGuidance(item: any) {
  const recommended = item.recommended ?? null;
  const options = item.kind === "decision" ? (item.options ?? []) : [];
  const pick = recommended?.option ? options.find((option: any) => option.id === recommended.option) : null;
  if (!recommended?.reason) return "";
  return `<div class="gate-block"><p class="label-caps">Recommended</p><p class="gate-recommendation">${pick ? `<strong>${escapeHtml(pick.label)}</strong>: ` : ""}${escapeHtml(recommended.reason)}</p></div>`;
}

// A record attached to a gate reads by its title and kind with the counts that matter; a repository file keeps its path, since code is its subject.
export function inspectLabel(artifact: any, ctx: any) {
  const record = artifact.record ?? null;
  const count = (value: any, word: any) => plural(Number.isInteger(value) ? value : 0, word);
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

const DOCUMENT_ICONS: Record<string, any> = { design: "document", "change-map": "grid", "review-ledger": "flask", decision: "scale", requirements: "document" };
const DOCUMENT_ORDER: Record<string, number> = { design: 0, "change-map": 1, "review-ledger": 2, decision: 3, requirements: 4 };
const SHOWN_DOCUMENTS = 5;

// One attached file as a row: its title or file name as the link, its kind with the counts that matter below it, a warning badge for a missing file,
// and a button that opens it in the side panel beside the question.
function documentRow(artifact: any, ctx: any) {
  const { label, code } = inspectLabel(artifact, ctx);
  const record = artifact.record ?? null;
  const segments = String(artifact.path).split("/");
  const folder = segments.slice(0, -1).join("/") || "repository root";
  let name, description;
  if (code) [name, description] = [segments.at(-1), `Source · ${folder}`];
  else if (record?.kind === "design" && record.title) [name, description] = [record.title, label];
  else {
    const [first, ...rest] = label.split(" · ");
    [name, description] = [first, rest.join(" · ")];
  }
  const icon = !artifact.available ? "warning" : code ? "code" : DOCUMENT_ICONS[record?.kind] ?? "file";
  const tone = !artifact.available ? "warning" : code ? "neutral" : "accent";
  const subject = code ? " data-code-subject" : "";
  const title = artifact.available && ctx.hasArtifact(artifact.path)
    ? `<a class="title-link" href="./review?artifact=${encodeURIComponent(artifact.path)}" data-artifact="${escapeHtml(artifact.path)}"${subject}>${escapeHtml(name)}</a>`
    : `<span${subject}>${escapeHtml(name)}</span>`;
  const mark = !artifact.available
    ? '<prism-badge slot="kind" variant="status" tone="warning">Not found</prism-badge>'
    : "";
  const open = artifact.available
    ? `<prism-button slot="action" variant="ghost" shape="square" size="sm" icon="panel" label="${escapeHtml(`Open ${name} in the side panel`)}" tip="Open in side panel" data-side-artifact="${escapeHtml(artifact.path)}"></prism-button>`
    : "";
  return `<prism-row wrap reveal${mark ? " stack" : ""} icon="${icon}" tone="${tone}">${title}${description ? `<span slot="description">${escapeHtml(description)}</span>` : ""}${mark}${open}</prism-row>`;
}

// The files the question refers to, Prism's records first, then documents, then code, with the first few shown and the rest a click away.
function documentsBlock(item: any, ctx: any) {
  const artifacts = item.artifacts ?? [];
  if (!artifacts.length) return "";
  const rank = (artifact: any) => artifact.record?.kind in DOCUMENT_ORDER ? DOCUMENT_ORDER[artifact.record.kind] : inspectLabel(artifact, ctx).code ? 6 : 5;
  const rows = artifacts.map((artifact: any, index: number) => ({ artifact, index })).sort((left: any, right: any) => rank(left.artifact) - rank(right.artifact) || left.index - right.index).map(({ artifact }: any) => documentRow(artifact, ctx));
  const list = (part: string[], label: string) => `<div class="prism-rows gate-documents" role="list" aria-label="${label}">${part.join("")}</div>`;
  const rest = rows.slice(SHOWN_DOCUMENTS);
  const more = rest.length ? `<prism-disclosure class="gate-documents-more" summary="${escapeHtml(`${rest.length} more`)}">${list(rest, "More documents")}</prism-disclosure>` : "";
  const gone = item.stale ? `<p class="notice">Every file this question refers to is gone, so it may no longer apply. The agent that asked it withdraws it when it does not.</p>` : "";
  return `<div class="gate-block"><p class="label-caps">${escapeHtml(`Documents · ${artifacts.length}`)}</p>${list(rows.slice(0, SHOWN_DOCUMENTS), "Documents")}${more}${gone}</div>`;
}

// A document row's button opens its file in the side panel and keeps the question in view.
function bindDocuments(container: any, ctx: any) {
  container.addEventListener("click", (event: any) => {
    const button = event.target.closest?.("[data-side-artifact]");
    if (!button || !container.contains(button) || !ctx.sidePanel) return;
    event.preventDefault();
    void ctx.sidePanel.show(button.dataset.sideArtifact);
  });
}

// An approval gate is the target approval:<id> of the review app's actions, every other gate the target gate:<initiative>/<id>.
const answerTarget = (item: any) => item.kind === "approval" ? `approval:${item.id}` : `gate:${item.initiative.id}/${item.id}`;

// The answer's place in the card: the shared action renderer draws the gate.answer listing of its target into it once the page is drawn.
// The panel beside the question opens with who asked, then the answer, then Withdraw, which a question rarely needs.
function answerSlot(item: any) {
  const owner = item.kind === "approval" ? " data-approval" : ` data-initiative="${escapeHtml(item.initiative.id)}"`;
  return `<div class="gate-answer">${gateAsker(item)}<div class="gate-answer-form" data-gate="${escapeHtml(item.id)}"${owner} data-answer-target="${escapeHtml(answerTarget(item))}"><p class="muted action-loading">Loading…</p></div>${gateWithdraw(item)}</div>`;
}

const ARCHIVE_SESSION = (launch: any) => `<prism-button variant="ghost" data-archive-session data-launch="${escapeHtml(launch.id)}" text="Archive session"></prism-button>`;

/** The form options of a gate's answer for the shared action renderer: its cards, its words, and Archive session after a no-result gate's submit. */
export function answerFormOptions(item: any) {
  return {
    heading: "Your answer",
    tone: (option: any) => option.value === "request-changes" ? "danger" : null,
    leading: () => item.launch ? "" : sendTo(item),
    trailing: () => item.launch ? ARCHIVE_SESSION(item.launch) : "",
    wording: (_action: any, form: any) => {
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

// An approval gate names the requirement or ADR in full, with its scope and the status an approval records, since the answer applies to exactly that file.
// Both statuses are plain text that wraps, so the whole status that approving writes reads at every width; a status of up to 200 characters fits no one-line label.
// The work item an approval serves links to its initiative and slice once the roadmap or the initiative's record knows them, as wrapping text so a long title reads whole.
// Requirements are often approved before their roadmap entry exists, so an id that names nothing yet stays plain text that says so.
function servedWork(item: any, ctx: any) {
  const work = item.workItem;
  if (!work?.initiative) return "";
  const { initiative, slice } = work;
  const unknown = (id: string, why: string) => `<span class="approval-work-part"><span data-code-subject>${escapeHtml(id)}</span> <span class="muted">${why}</span></span>`;
  const named = initiative.known ? artifactLink(`initiative:${initiative.id}`, ctx, initiative.title) : unknown(initiative.id, "not on the roadmap yet");
  const part = slice ? (initiative.known && slice.known ? artifactLink(`slice:${initiative.id}/${slice.slug}`, ctx, slice.title) : unknown(slice.slug, "no slice yet")) : null;
  return workRow(named, part, null, " approval-work");
}

// The file an approval applies to, as a row that names it by title and kind, links it, and shows its whole path, since the answer applies to exactly that file.
function approvalDocument(item: any, ctx: any) {
  const path = item.artifact.path;
  const kind = item.artifact.kind === "adrs" ? "Decision" : "Requirements";
  const name = item.artifact.title || path.split("/").pop();
  const title = ctx.hasArtifact(path) ? `<a class="title-link" href="./review?artifact=${encodeURIComponent(path)}" data-artifact="${escapeHtml(path)}">${escapeHtml(name)}</a>` : `<span>${escapeHtml(name)}</span>`;
  const open = `<prism-button slot="action" variant="ghost" shape="square" size="sm" icon="panel" label="${escapeHtml(`Open ${name} in the side panel`)}" tip="Open in side panel" data-side-artifact="${escapeHtml(path)}"></prism-button>`;
  return `<div class="prism-rows gate-documents" role="list" aria-label="Document"><prism-row wrap reveal icon="${kind === "Decision" ? "scale" : "document"}" tone="accent">${title}<span slot="description">${kind} · <span data-code-subject>${escapeHtml(path)}</span></span>${open}</prism-row></div>`;
}

function approvalSubject(item: any, ctx: any) {
  const scope = item.artifact.scope?.label ?? "workspace";
  const status = (text: string, modifier: any) => `<span class="approval-status-value ${modifier}">${escapeHtml(text)}</span>`;
  const change = item.recorded && item.recorded !== item.status
    ? `<span class="approval-status">${status(item.recorded, "is-recorded")}<span class="approval-status-arrow" aria-hidden="true">→</span><span class="sr-only">to</span>${status(item.status, "is-approved")}</span>`
    : `<span class="approval-status">${status(item.status, "is-approved")}</span>`;
  return `${keyValues([
      ["Document", approvalDocument(item, ctx)],
      ["Scope", chip(escapeHtml(scope))],
      ["Approving records", change]
    ])}
    ${item.ambiguous ? `<p class="notice">Another pending approval holds this question's id, so an answer cannot tell which file it approves and is refused. The agent asks again for the file it means.</p>` : ""}
    ${item.changed ? `<p class="notice">The file changed since this approval was asked, so approving it is refused. The agent asks again for the current version.</p>` : ""}`;
}

// A question the server no longer takes an answer to, such as one of a shipped initiative, names why in place of the form.
function unavailableAnswer(item: any) {
  return `<prism-banner class="gate-unavailable" tone="warning" heading="Cannot be answered"><p>${escapeHtml(item.unavailable)}</p></prism-banner>`;
}

export function gateDetail(item: any, ctx: any) {
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

export const NO_RESULT_CHIP = "Run ended without a result";
const NO_MESSAGE = "The run left no message.";
const LAST_MESSAGE = "\n\nIts last message:\n\n";

/** The last message a launched run left, as its no-result gate's context holds it, or null when the run left none. */
export function lastMessage(context: any) {
  const text = typeof context === "string" ? context : "";
  const at = text.indexOf(LAST_MESSAGE);
  return at === -1 ? null : text.slice(at + LAST_MESSAGE.length);
}

// A time as its day and time of day, such as 21 Nov 14:02.
function dayTime(at: any) {
  const time = Date.parse(at ?? "");
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const day = date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const clock = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `<time datetime="${escapeHtml(at)}">${escapeHtml(`${day} ${clock}`)}</time>`;
}

// A launched run that ended without a result: one card with its session, its last message, one answer that resumes it, and Archive session.
function noResultDetail(item: any, ctx: any) {
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

function given(item: any) {
  const negative = item.answer.choice === "request-changes";
  return `${badge(choiceLabel(item, item.answer.choice), negative ? "danger" : "success")}${item.answer.note ? ` <span>${escapeHtml(item.answer.note)}</span>` : ""}`;
}

// A detail that is not an open gate: its head, a heading, and what the page knows of it.
function detailSheet({ head = "", title, body = "", className = "" }: { head?: string; title: string; body?: string; className?: string }) {
  return `<article class="gate attention-item ${className}">
    <header class="gate-head"><div class="gate-chips">${head}</div><h3 class="gate-question">${title}</h3></header>
    ${body ? `<div class="gate-main">${body}</div>` : ""}
  </article>`;
}

function answeredDetail(item: any, ctx: any) {
  return detailSheet({
    className: `is-answered gate-${escapeHtml(item.kind)}`,
    head: `${kindChip(item)}<span class="attention-where">${location(item, ctx)}</span>${when(item.answer.answeredAt, "attention-time gate-time")}`,
    title: escapeHtml(item.question),
    body: `${gateAsker(item)}<p class="gate-given">${given(item)}</p>${gateContinue(item)}<p class="attention-footnote muted">An agent that is waiting for these answers resumes on its own shortly after your last answer. Any other agent receives them with your next message in its conversation, even a short one such as “go”.</p>`
  });
}

// An answered question whose asker cannot read the answer offers to continue the work; the shared action renderer draws its gate.continue
// listing into this place, with each way that applies and why the others do not.
function gateContinue(item: any) {
  const asker = item.asker;
  if (!asker || item.unavailable || asker.state === "waiting" || asker.state === "open" || asker.launched) return "";
  return `<div class="gate-continue" data-gate="${escapeHtml(item.id)}" data-continue-target="${escapeHtml(answerTarget(item))}"></div>`;
}

// A continuation confirmed in a native dialog can wait on the person for a while, so its apply gets the dialog's time, and a wake
// its 120 seconds after it.
const CONTINUE_DEADLINE_MS = 330000;

const CONTINUE_HINT = "Nothing starts until you confirm outside the browser.";
const CONTINUE_PICK = "Pick a way to continue.";

/** The form options of Withdraw for the shared action renderer: what it does beside its button. */
export const withdrawFormOptions = {
  wording: (action: any, form: any) => ({ submit: { label: action.label, variant: "ghost" }, hint: form.ready ? action.effect : form.hint, ready: false })
};

/** The form options of Continue for the shared action renderer: its ways as cards, and, when none applies, why each does not. */
export const continueFormOptions = {
  heading: "Continue the work",
  wording: (_action: any, form: any) => ({ submit: { label: "Continue", variant: "primary" }, hint: form.ready ? CONTINUE_HINT : form.hint && CONTINUE_PICK, ready: form.ready }),
  unavailable: (action: any) => (action.fields?.[0]?.options ?? []).filter((option: any) => option.reason).map((option: any) => `<p class="action-reason">${escapeHtml(`${option.label}: ${option.reason}`)}</p>`).join("")
};

// A closed question shows the browser answer, the person's withdrawal, or the reason the agent gave when it resolved the question without one.
function closedDetail(item: any, ctx: any) {
  const outcome = item.answer ? given(item) : badge(item.reason === "The person withdrew this question without an answer." ? "Withdrawn" : "Closed by the agent");
  return detailSheet({
    className: `is-closed gate-${escapeHtml(item.kind)}`,
    head: `${kindChip(item)}<span class="attention-where">${location(item, ctx)}</span>${when(item.closedAt, "attention-time gate-time")}`,
    title: escapeHtml(item.question),
    body: `<p class="gate-given">${outcome}</p>${item.reason ? `<p class="muted">${escapeHtml(item.reason)}</p>` : ""}`
  });
}

// A refused answer shows beside the form: the server's reason for an action it no longer offers, and a re-render shows the question as it now stands.
export function answerError(error: any) {
  if (error.code === "action_unavailable" || error.code === "gate_answered") return { message: error.message, rerender: true };
  if (error.code === "unknown_gate") return { message: "The agent already resolved or withdrew this question.", rerender: true };
  if (error.code === "artifact_changed") return { message: "The file changed since this approval was asked, so nothing was recorded. The agent asks again for the current version.", rerender: true };
  if (error.code === "approval_ambiguous") return { message: "Another pending approval holds this question's id, so nothing was recorded. The agent asks again for the file it means.", rerender: true };
  if (error.code === "author_unknown") return { message: "Git names no user for this checkout, so the approval cannot record who gave it. Set one with git config user.name, then answer again.", rerender: false };
  return { message: error.message, rerender: false };
}

// Each open gate's answer is the shared action renderer's form of its gate.answer listing; the person's unsent answer survives the page
// drawing Attention again when live data changes, and the page gives focus back to the control that had it by its focus key.
function mountAnswers(container: any, ctx: any, gates: any) {
  const lists: any[] = [];
  if (!ctx.actionApi) return lists;
  const drafts = (ctx.state.answerDrafts ??= {});
  for (const slot of container.querySelectorAll(".gate-answer-form[data-answer-target]")) {
    const item = gates.find((gate: any) => gate.id === slot.dataset.gate && answerTarget(gate) === slot.dataset.answerTarget);
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
      onRefused: (_action: any, result: any) => {
        const refusal = answerError({ code: result.code === "unknown_target" ? "unknown_gate" : result.code, message: result.reason ?? result.message ?? "The answer was not recorded." });
        if (refusal.rerender) queueMicrotask(() => ctx.rerender());
        return refusal.message;
      }
    }));
  }
  return lists;
}

// Withdraw and Continue are the shared action renderer's forms of a gate's gate.withdraw and gate.continue listings, beside its answer.
// A place whose listing offers neither stays empty and hidden, and a refusal shows in words beside the button.
function mountGateActions(container: any, ctx: any) {
  const lists: any[] = [];
  if (!ctx.actionApi) return lists;
  const drafts = (ctx.state.answerDrafts ??= {});
  const refused = (fallback: string) => (_action: any, result: any) => {
    const refusal = answerError({ code: result.code === "unknown_target" ? "unknown_gate" : result.code, message: result.reason ?? result.message ?? fallback });
    if (refusal.rerender) queueMicrotask(() => ctx.rerender());
    return refusal.message;
  };
  const mount = (slot: any, target: string, id: string, options: any) => {
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
  // A continuation waits on the person's confirmation outside the browser, so its apply gets the dialog's time; the page keeps one such API,
  // so a redrawn Continue starts from its last listing rather than showing again only once its listing is read.
  const api = continueApi(ctx.actionApi);
  for (const slot of container.querySelectorAll(".gate-continue[data-continue-target]")) {
    mount(slot, slot.dataset.continueTarget, "gate.continue", {
      api,
      form: continueFormOptions,
      onApplied: (_action: any, _input: any, result: any) => {
        const wake = result?.wake;
        ctx.showToast(wake ? (wake.delivered ? "The wake was sent. The cloud session reads your answer from Prism's records." : `The wake was not delivered: ${wake.reason ?? "Claude Code gave no reason."}`) : "The work continues. The new session acts first on your answer.");
        ctx.rerender();
      },
      onRefused: refused("Nothing started.")
    });
  }
  return lists;
}

const continueApis = new WeakMap();

function continueApi(actionApi: any) {
  if (!continueApis.has(actionApi)) continueApis.set(actionApi, { ...actionApi, apply: (request: any) => actionApi.apply(request, { deadlineMs: CONTINUE_DEADLINE_MS }) });
  return continueApis.get(actionApi);
}

// A host's permission request: the session waits until the person allows it, after a native confirmation, or refuses it.
// The action and reason arrive as the server's shown text, one line in which every character the host sent shows, so they are written as plain text.
/** The place line of a card about a launched session: its initiative's title and its host's label, the same for every host. */
export function sessionPlace(initiative: any, host: any) {
  return [initiative?.title ?? initiative?.id, host?.label ?? host?.id].filter(Boolean).join(" · ");
}

export function permissionDetail(item: any, draft: any = {}) {
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

// How long an approval may wait for its answer: the session shows its dialog, and the person has up to two minutes to answer it.
const PERMISSION_DEADLINE_MS = 200000;

/** A refused permission answer in words, and whether the request may no longer wait, so the page reads Attention again. */
export function permissionError(code: any, message: any) {
  const text = typeof message === "string" && message ? message : "The answer was not applied.";
  if (code === "unknown_request") return { message: "This request no longer waits: the session answered it, withdrew it, or ended.", rerender: true };
  if (typeof code === "string" && code.startsWith("confirmation_")) return { message: `The approval was not confirmed, so the request still waits. ${text}`, rerender: false };
  return { message: text, rerender: false };
}

// Archive session archives the launched session, which closes its no-result gate and starts no run.
// The button follows the answer's submit button, which the shared renderer draws after the page, so the detail listens for it.
function bindArchiveSession(container: any, ctx: any) {
  container.querySelector(".attention-detail")?.addEventListener("click", async (event: any) => {
    const button = event.target.closest?.("[data-archive-session]");
    if (!button || button.hasAttribute("disabled")) return;
    button.setAttribute("disabled", "");
    const headers = { "Content-Type": "application/json", ...(typeof ctx.writeHeaders === "function" ? ctx.writeHeaders() : {}) };
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

function bindPermissions(container: any, ctx: any) {
  const drafts = (ctx.state.permissionDrafts ??= {});
  for (const form of container.querySelectorAll(".permission-answer")) {
    const id = form.dataset.permission;
    const launch = form.dataset.launch;
    const buttons = [...form.querySelectorAll("[data-permission-decision]")];
    const hint = form.querySelector(".permission-hint");
    const failure = form.querySelector(".gate-error");
    for (const button of buttons) {
      button.addEventListener("click", async () => {
        const decision = button.dataset.permissionDecision;
        const draft = (drafts[id] ??= {});
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

// A change's action reads by its own name: the last part of its id in words, such as "Security review" for initiative.securityReview.
function changeLabel(action: any) {
  const words = String!(action ?? "").split(".").pop()!.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Change";
}

function changeValue(value: any) {
  if (value === null || value === undefined) return "none";
  if (typeof value === "object") return Object.entries<any>(value).filter(([, item]) => item !== null && item !== "").map(([key, item]) => `${key}: ${typeof item === "object" ? JSON.stringify(item) : item}`).join(", ") || "none";
  return String(value);
}

// The author is what the applying checkout's Git configuration claims, so the page names it as given and never as verified.
function changeAuthor(by: any) {
  return by?.name || by?.email || "An unknown person";
}

function changeWhere(entry: any, ctx: any) {
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

const isObject = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
// The characters of a comment that Recent changes shows.
const COMMENT_SHOWN = 280;

function changeStep(before: any, after: any) {
  return `<span class="recent-change-before">${escapeHtml(before)}</span> <span aria-hidden="true">→</span><span class="sr-only">to</span> <span class="recent-change-after">${escapeHtml(after)}</span>`;
}

// Two object values, such as model names, show only the parts that changed, so a long value does not hide what differs.
function changeValues(entry: any) {
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
function authorText(by: any) {
  const name = changeAuthor(by);
  return by?.email && by.email !== name ? `${escapeHtml(name)} <span class="muted">(${escapeHtml(by.email)})</span>` : escapeHtml(name);
}

export function changeHtml(entry: any, ctx: any) {
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
let following: any = null;

function followChanges(container: any, ctx: any, questions: any) {
  if (!following) document.addEventListener("prism:action", (event) => following?.(event));
  following = (event: any) => {
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
function noteEntry(item: any, ctx: any) {
  const roadmapLink = artifactChip("roadmap", ctx, "Roadmap");
  const describe = ({
    "pending-note": () => ({ kind: "Pending item", icon: "document", tone: "neutral", title: escapeHtml(item.text), text: "", where: location(item, ctx), meta: item.initiative?.title ?? "" }),
    unlisted: () => ({ kind: "Needs prioritization", icon: "roadmap", tone: "warning", title: `${escapeHtml(item.initiative.title ?? item.initiative.id)} is not on the roadmap`, text: `${escapeHtml(item.initiative.title ?? item.initiative.id)} has an initiative record but no roadmap entry. Ask the agent to run <code>roadmap</code>.`, where: location(item, ctx), meta: "Needs prioritization" }),
    "open-question": () => ({ kind: "Roadmap question", icon: "roadmap", tone: "neutral", title: escapeHtml(item.text), text: "", where: roadmapLink, meta: "Open question on the roadmap" }),
    "roadmap-missing": () => ({ kind: "No roadmap", icon: "warning", tone: "warning", title: "No roadmap", text: "No roadmap record exists yet. Ask the agent to run <code>setup</code>.", where: "", meta: "Roadmap" }),
    "roadmap-problem": () => ({ kind: "Roadmap problem", icon: "warning", tone: "danger", title: "The roadmap has a problem", text: messageHtml(item.message), where: roadmapLink, meta: "Roadmap problem" }),
    config: () => ({ kind: "Workflow settings", icon: "warning", tone: "warning", title: "Check the workflow settings", text: messageHtml(item.message), where: "", meta: "Workflow settings" }),
    "format-findings": () => ({ kind: "Format findings", icon: "document", tone: "warning", title: formatTitle(item), text: `${escapeHtml(formatSummary(item))} ${artifactLink("attention:formats", ctx, "See the findings")}`, where: "", meta: "Format findings" })
  } as Record<string, any>)[item.type];
  if (item.type === "migration-question" || item.type === "migration-failed") return runEntry(item, ctx);
  const content = describe ? describe() : { kind: item.type, icon: "info", tone: "neutral", title: escapeHtml(item.type), text: "", where: "", meta: "" };
  return {
    row: { icon: content.icon, tone: content.tone, title: content.title, meta: escapeHtml(content.meta) },
    detail: detailSheet({ className: `note-${escapeHtml(item.type)}`, head: `${badge(content.kind)}<span class="attention-where">${content.where}</span>`, title: content.title, body: content.text ? `<p class="attention-note">${content.text}</p>` : "" })
  };
}

// A format migration run on Attention: its question, which one answer on the run's page settles, its failure with the rerun, or its wait for a host.
const runRef = (item: any) => `migration-run:${item.run}`;
const runTitle = (item: any) => `Format migration · ${item.label} ${scopeWords(item.scope)}`;
const runCode = (path: any) => `<span class="run-code" data-code-subject>${escapeHtml(path)}</span>`;
const openRun = (item: any, label: string, variant = "") => `<prism-button${variant ? ` variant="${variant}"` : ""} data-artifact="${escapeHtml(runRef(item))}">${escapeHtml(label)}</prism-button>`;

function runEntry(item: any, ctx: any) {
  const where = `<span class="attention-where">${whereChip(item.scope)}</span>`;
  if (item.type === "migration-question") {
    const files = item.asking ?? [];
    const title = escapeHtml(runTitle(item));
    const rows = `<div class="prism-rows" role="list" aria-label="Files that ask you">${files.map((file: any) => `<prism-row icon="document" tone="accent">${runCode(file.path)}<span slot="description">${escapeHtml(file.kinds.map((kind: any) => POINT_KINDS[kind] ?? kind).join(", "))}</span><prism-badge slot="kind" tone="accent">${file.points}</prism-badge></prism-row>`).join("")}</div>`;
    const note = `Prism could not settle ${plural(item.points, "point")} in ${files.length} of the run's ${plural(item.files, "file")}. One answer on the run's page settles all of them, each prefilled with Prism's recommendation.`;
    return {
      row: { icon: "layers", tone: "accent", unread: true, title, meta: escapeHtml(`${plural(item.points, "point")} in ${files.length} of ${plural(item.files, "file")} · Format migration`), end: shortTime(item.askedAt) },
      detail: detailSheet({ className: "note-migration-question", head: `${badge("Format migration asks you", "accent")}${where}${when(item.askedAt, "attention-time gate-time")}`, title, body: `<p class="attention-note">${escapeHtml(note)}</p>${rows}<div class="gate-actions">${openRun(item, "Answer on the run's page", "primary")}</div>` })
    };
  }
  const title = escapeHtml(`${runTitle(item)} failed`);
  const files = item.artifacts ?? [];
  const rows = `<div class="prism-rows" role="list" aria-label="Files in the run">${files.map((file: any) => `<prism-row icon="document" tone="neutral">${runCode(file.path)}</prism-row>`).join("")}</div>`;
  return {
    row: { icon: "warning", tone: "danger", unread: true, title, meta: escapeHtml(`${item.reason ?? "The run failed"} · Failed`), end: shortTime(item.at) },
    detail: detailSheet({ className: "note-migration-failed", head: `${badge("Format migration failed", "danger")}${where}${when(item.at, "attention-time gate-time")}`, title, body: `<p class="attention-note run-reason">${escapeHtml(item.reason ?? "The run failed without a reason.")}</p><p class="muted">Nothing of the run was applied. Its ${plural(files.length, "file")} still ${files.length === 1 ? "breaks" : "break"} the format.</p>${rows}<div class="gate-actions">${openRun(item, "Open the run")}<prism-button variant="primary" data-migration-rerun="${escapeHtml(item.run)}">Run again</prism-button></div>` })
  };
}

function waitingRunEntry(item: any) {
  const title = escapeHtml(`${runTitle(item)} waits for a host`);
  return {
    row: { icon: "clock", tone: "warning", title, meta: escapeHtml(`${item.reason ?? "No host is available on this machine"} · Problem`) },
    detail: detailSheet({ className: "watch-migration-waiting", head: `${badge("Waits for a host", "warning")}<span class="attention-where">${whereChip(item.scope)}</span>`, title, body: `<p class="watch-detail run-reason">${escapeHtml(item.reason ?? "No host is available on this machine.")}</p><div class="gate-actions">${openRun(item, "Open the run")}</div>` })
  };
}

function recordName(path: any, ctx: any) {
  const named = ctx.describe?.(path) ?? recordLabel(path);
  return named.code ? null : named.kind;
}

// Agent-side state in Watch: its row and its detail.
function watchEntry(item: any, ctx: any) {
  if (item.type === "migration-waiting") return waitingRunEntry(item);
  const where = location(item, ctx);
  const slice = item.slice?.title ?? item.initiative?.title ?? "";
  const describe = ({
    blocked: () => ({ icon: "warning", tone: "danger", title: "The slice is blocked", meta: slice, head: badge("blocked", "danger"), text: "The slice is blocked." }),
    findings: () => ({ icon: "flask", tone: item.blocking ? "danger" : "warning", title: item.blocking ? plural(item.blocking, "blocking finding") : plural(item.unresolved, "open finding"), meta: `Review ledger · ${slice}`, head: item.blocking ? badge(plural(item.blocking, "blocking finding"), "danger") : badge(plural(item.unresolved, "open finding"), "warning"), text: artifactChip(item.path, ctx, "Open the findings board") }),
    active: () => ({ icon: "agent", tone: "info", title: `${escapeHtml(item.workers.join(", ") || "An agent")} ${item.activity === "design" ? "is designing" : "is implementing"}`, meta: `${slice}${item.label ? ` · ${item.label}` : ""}`, head: badge("active", "info"), text: `${escapeHtml(item.activity)}${item.label ? ` · ${escapeHtml(item.label)}` : ""} · ${escapeHtml(item.workers.join(", "))}` }),
    "failed-verification": () => ({ icon: "flask", tone: "danger", title: `${escapeHtml(slice)} failed verification`, meta: failedReason(item), head: badge("failed verification", "danger"), text: `${escapeHtml(failedReason(item))}${item.finishedAt ? ` · ${when(item.finishedAt)}` : ""}` }),
    "ready-to-ship": () => ({ icon: "check-circle", tone: "success", title: "Ready to ship", meta: slice, head: badge("ready to ship", "success"), text: "Every slice is done; the orchestrator records the ship decision at graduation." }),
    "record-problem": () => ({ icon: "warning", tone: "danger", title: "A record has a problem", meta: recordName(item.path, ctx) ?? "Record", head: badge("record problem", "danger"), text: `${artifactChip(item.path, ctx, recordName(item.path, ctx) ?? undefined)} ${escapeHtml(item.message)}` })
  } as Record<string, any>)[item.type];
  const row = describe ? describe() : { icon: "info", tone: "neutral", title: escapeHtml(item.type), meta: "", head: badge(item.type), text: "" };
  return {
    row: { icon: row.icon, tone: row.tone, title: row.title, meta: escapeHtml(row.meta) },
    detail: detailSheet({ className: `watch-${escapeHtml(item.type)}`, head: `${row.head}<span class="attention-where">${where}</span>`, title: row.title, body: row.text ? `<p class="watch-detail">${row.text}</p>` : "" })
  };
}

// A failed verification run's reason in words, with the number of failing tests when the run names them.
const RUN_REASONS: Record<string, any> = {
  command_failed: "The tests failed",
  timed_out: "The tests timed out",
  cancelled: "The run was cancelled",
  tracked_files_changed: "The run changed tracked files",
  frozen_tests_changed: "The frozen tests changed",
  start_content_missing: "The slice's start content is missing",
  component_boundary: "The change crossed its component's boundary"
};

export function failedReason(item: any) {
  const words = RUN_REASONS[item.reason] ?? "The run failed";
  return Number.isInteger(item.failingCount) && item.failingCount > 0 ? `${words}, ${plural(item.failingCount, "test")} failed` : words;
}

// A claim in the Watch group: who holds which slice for what, and how long it has left or since when it lapsed; it offers no action.
function claimEntry(claim: any, ctx: any) {
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

function inboxRow(key: any, row: any) {
  return `<prism-inbox-item value="${escapeHtml(key)}"${row.icon && !row.start ? ` icon="${row.icon}" tone="${row.tone ?? "neutral"}"` : ""}${row.unread ? " unread" : ""}>${row.start ?? ""}${row.title}${row.meta ? `<span slot="description">${row.meta}</span>` : ""}${row.end ? `<span slot="end">${row.end}</span>` : ""}</prism-inbox-item>`;
}

// A group of the list: a label with its count and the rows to pick from.
function group(id: string, label: string, entries: any, { count = entries.length, tone = "neutral", note = "" }: any = {}) {
  if (!entries.length) return "";
  return `<section class="attention-group" aria-labelledby="attention-group-${id}">
    <h2 class="attention-group-label" id="attention-group-${id}"><span>${escapeHtml(label)}</span> <prism-badge tone="${tone}">${count}</prism-badge></h2>
    ${note ? `<p class="attention-footnote attention-group-note muted">${escapeHtml(note)}</p>` : ""}
    <prism-inbox label="${escapeHtml(label)}" data-inbox>${entries.map(({ key, row }: { key: any; row: any }) => inboxRow(key, row)).join("")}</prism-inbox>
  </section>`;
}

// The width below which the list and the picked item take turns, as the Attention stylesheet's phone rules say.
const PHONE_QUERY = "(max-width: 720px)";

// A question chosen on a filtered page opens Everything with that question picked, so it can be answered there.
let pendingSelection: any = null;

/** Opens Attention with the question `gate` selected and its answer form shown, as another page's Answer does. */
export function openQuestion(ctx: any, gate: any) {
  if (gate) pendingSelection = `gate:${gate}`;
  ctx.openArtifact?.("attention");
}

// The filter's name and count above its items, with the way back to everything, in the page head.
function filterLine(container: any, text: string, ctx: any) {
  setPageSub(container, pageSub(escapeHtml(text), { end: '<a href="./review?artifact=attention" data-artifact="attention">Show everything</a>' }), ctx);
}

const where = (item: any) => [item.initiative?.title, item.slice?.title].filter(Boolean);

// One item of a filtered page: its kind tile, its title as a link to where it is handled, where it belongs and what it is, its kind, and its time.
function filteredItem({ kind, item }: { kind: any; item: any }, ctx: any) {
  const slice = item.slice?.title ?? "";
  const sliceRef = item.slice && item.initiative ? `slice:${item.initiative.id}/${item.slice.slug}` : null;
  const initiativeRef = item.initiative ? `initiative:${item.initiative.id}` : null;
  const plain = (...parts: any[]) => parts.filter(Boolean).map(escapeHtml).join(" · ");
  const look = ({
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
    config: () => ({ icon: "warning", tone: "warning", title: "Check the workflow settings", ref: null, sub: messageHtml(item.message ?? ""), chip: ["Problem", "warning"] }),
    "format-findings": () => ({ icon: "document", tone: "warning", title: formatTitle(item), ref: "attention:formats", sub: escapeHtml(formatSummary(item)), chip: ["Format findings", "warning"] }),
    "migration-question": () => ({ icon: "layers", tone: "accent", title: escapeHtml(runTitle(item)), ref: runRef(item), sub: escapeHtml(`${plural(item.points, "point")} to answer · Format migration`), chip: ["Question", "accent"], at: item.askedAt, action: "Answer" }),
    "migration-failed": () => ({ icon: "warning", tone: "danger", title: escapeHtml(`${runTitle(item)} failed`), ref: runRef(item), sub: escapeHtml(item.reason ?? "The run failed"), chip: ["Failed", "danger"], at: item.at }),
    "migration-waiting": () => ({ icon: "clock", tone: "warning", title: escapeHtml(`${runTitle(item)} waits for a host`), ref: runRef(item), sub: escapeHtml(item.reason ?? "No host is available on this machine"), chip: ["Problem", "warning"] })
  } as Record<string, any>)[item.type]?.() ?? { icon: "info", tone: "neutral", title: escapeHtml(item.type), ref: null, sub: "", chip: [kind, "neutral"] };
  const linked = look.ref && ctx.hasArtifact(look.ref);
  const select = look.select ? ` data-attention-select="${escapeHtml(look.select)}"` : "";
  const title = linked ? `<a href="./review?artifact=${encodeURIComponent(look.ref)}" data-artifact="${escapeHtml(look.ref)}"${select}>${look.title}</a>` : look.title;
  const time = liveTime(look.at, { format: "short", slot: "time" });
  const action = linked ? `<prism-button slot="action" size="sm" data-artifact="${escapeHtml(look.ref)}"${select}>${escapeHtml(look.action ?? "Open")}</prism-button>` : "";
  return `<prism-row icon="${escapeHtml(look.icon)}" tone="${escapeHtml(look.tone)}">${title}${look.sub ? `<span slot="description">${look.sub}</span>` : ""}<prism-chip slot="kind" tone="${escapeHtml(look.chip[1])}">${escapeHtml(look.chip[0])}</prism-chip>${time}${action}</prism-row>`;
}

function bindSelection(container: any) {
  container.addEventListener("click", (event: any) => {
    const chosen = event.target.closest?.("[data-attention-select]");
    if (chosen) pendingSelection = chosen.dataset.attentionSelect;
  }, { capture: true });
}

// Attention filtered to one kind or one initiative: only its items, as rows that open where each is handled.
function renderFiltered(container: any, filter: any, ctx: any) {
  filterLine(container, `${filter.label} · ${filter.items.length} of ${filter.total} ${filter.total === 1 ? "item" : "items"}`, ctx);
  container.innerHTML = filter.items.length
    ? `<div class="prism-rows" role="list" aria-label="${escapeHtml(filter.label)}">${filter.items.map((entry: any) => filteredItem(entry, ctx)).join("")}</div>`
    : `<div class="attention-nothing">${emptyState("Nothing here waits on you", `No item of ${filter.label} needs you now.`)}</div>`;
  bindSelection(container);
  bindLinks(container, ctx);
}

// The questions answered or closed in the last 7 days, newest first, each with where it belongs and the answer or the reason it was closed.
function renderAnswered(container: any, answered: any, ctx: any) {
  filterLine(container, `Answered in the last 7 days · ${plural(answered.length, "question")}`, ctx);
  if (!answered.length) {
    container.innerHTML = `<div class="attention-nothing">${emptyState("Nothing answered this week", "No question was answered or closed in the last 7 days.")}</div>`;
    return;
  }
  container.innerHTML = `<div class="prism-rows" role="list" aria-label="Answered in the last 7 days">${answered.map((item: any) => {
    const place = [item.initiative ? artifactLink(`initiative:${item.initiative.id}`, ctx, item.initiative.title) : "", item.slice && item.initiative ? artifactLink(`slice:${item.initiative.id}/${item.slice.slug}`, ctx, item.slice.title) : ""].filter(Boolean).join(" · ");
    const outcome = item.answer ? given(item) : `${badge("Closed by the agent")}${item.reason ? ` <span>${escapeHtml(item.reason)}</span>` : ""}`;
    const tone = item.answer ? (item.answer.choice === "request-changes" ? "danger" : "success") : "neutral";
    return `<prism-row wrap icon="${item.answer ? "check-circle" : "close"}" tone="${tone}">${escapeHtml(item.question)}${place ? `<span slot="description">${place}</span>` : ""}<span slot="detail">${outcome}</span><prism-chip slot="kind" tone="${item.answer ? "success" : "neutral"}">${item.answer ? "Answered" : "Closed"}</prism-chip>${liveTime(item.at, { format: "short", slot: "time" })}</prism-row>`;
  }).join("")}</div>`;
  bindLinks(container, ctx);
}

// A format item's title and the line that says how many of its files keep an earlier Prism format.
const formatTitle = (item: any) => `${escapeHtml(item.label)} · ${escapeHtml(plural(item.count, "file"))} ${item.count === 1 ? "breaks" : "break"} the format`;
const formatSummary = (item: any) => item.earlier ? `${item.earlier} of them ${item.earlier === 1 ? "keeps" : "keep"} an earlier Prism format.` : "None of them keeps a Prism format.";

// The action of a nonconforming artifact's format migration: run a failed one again, answer one that asks, or open one that runs or waits.
function migrationAction(artifact: any) {
  const migration = artifact.migration;
  if (!migration?.run) return "";
  if (migration.status === "failed") return `<prism-button slot="action" size="sm" data-migration-rerun="${escapeHtml(migration.run)}">Run again</prism-button>`;
  const label = migration.status === "asking" ? "Answer" : "Open the run";
  return `<prism-button slot="action" size="sm" data-artifact="${escapeHtml(runRef(migration))}">${label}</prism-button>`;
}

// One nonconforming artifact: its path with its format mark, the scope that holds it, each broken rule with its message and line, and its migration's action.
function formatArtifact(artifact: any) {
  const scope = artifact.scope?.label ?? null;
  const mark = formatBadge({ rules: [...new Set((artifact.findings ?? []).map((finding: any) => finding.rule))].sort(), findings: artifact.findings ?? [] });
  const earlier = artifact.earlierFormat ? `Keeps format version ${artifact.earlierFormat.version}` : "Keeps no Prism format";
  return `<prism-row wrap icon="document" tone="warning"><span data-code-subject>${escapeHtml(artifact.path)}</span> ${mark}<span slot="description">${escapeHtml(earlier)} · ${plural((artifact.findings ?? []).length, "finding")}</span><span slot="detail">${findingsList(artifact.findings)}</span><prism-chip slot="kind"${scope ? ' tip="The record store scope that holds this file"' : ' tip="A file in this checkout"'}>${escapeHtml(scope ? `Scope ${scope}` : "Checkout")}</prism-chip>${migrationAction(artifact)}</prism-row>`;
}

function formatGroup(label: string, note: string, artifacts: any[]) {
  if (!artifacts.length) return "";
  return `<section class="format-group"><h4 class="format-group-label label-caps"><span>${escapeHtml(label)}</span> <prism-badge tone="warning">${artifacts.length}</prism-badge></h4><p class="format-group-note muted">${escapeHtml(note)}</p><div class="prism-rows" role="list" aria-label="${escapeHtml(label)}">${artifacts.map(formatArtifact).join("")}</div></section>`;
}

// A format's panel: its count and its artifacts by kind of break.
function formatPanel(entry: any) {
  const earlier = entry.artifacts.filter((artifact: any) => artifact.earlierFormat);
  const foreign = entry.artifacts.filter((artifact: any) => !artifact.earlierFormat);
  return `<prism-panel class="view-section format-panel" heading="${escapeHtml(entry.label)}" level="3" eyebrow="${escapeHtml(`Format version ${entry.version} · ${plural(entry.count, "file")} to look at`)}">
    ${formatGroup("Earlier Prism format", `These files keep an earlier version of the format; a format migration brings them to version ${entry.version}.`, earlier)}
    ${formatGroup("No Prism format", "These files keep no version of the format; a format migration rewrites them into it, keeping every statement.", foreign)}
  </prism-panel>`;
}

// The format findings page: every format whose files break it.
// A failed format migration run runs again from its sheet or its file's format finding, after the person confirms it.
function bindReruns(container: any, ctx: any) {
  for (const button of container.querySelectorAll("[data-migration-rerun]")) {
    button.addEventListener("click", async () => {
      button.toggleAttribute("disabled", true);
      if (await rerunRun(ctx, button.dataset.migrationRerun)) ctx.rerender();
      else button.toggleAttribute("disabled", false);
    });
  }
}

function renderFormats(container: any, data: any, ctx: any) {
  const filter = data.filter;
  filterLine(container, `${filter.label} · ${filter.items.length} of ${filter.total} ${filter.total === 1 ? "item" : "items"}`, ctx);
  const shown = (data.formats ?? []).filter((entry: any) => entry.count);
  container.innerHTML = shown.length
    ? `<div class="format-panels">${shown.map(formatPanel).join("")}</div>`
    : `<div class="attention-nothing">${emptyState("Every file keeps its format", "No requirement, decision, glossary, or feature file breaks its Prism format.")}</div>`;
  bindLinks(container, ctx);
  bindReruns(container, ctx);
}

export function render(container: any, entity: any, ctx: any) {
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
  // The questions and the failed format migration runs list newest first together, by when each was asked or failed; the notes without a time follow them.
  const timeOf = (item: any) => item.type === "gate" || item.type === "migration-question" ? item.askedAt : item.type === "migration-failed" ? item.at : null;
  const millis = (item: any) => { const at = Date.parse(timeOf(item) ?? ""); return Number.isFinite(at) ? at : -Infinity; };
  const timed = data.needsYou.map((item: any, index: number) => ({ item, index })).filter(({ item }: any) => timeOf(item) !== null)
    .sort((left: any, right: any) => millis(right.item) - millis(left.item) || left.index - right.index);
  const notes = data.needsYou.filter((item: any) => timeOf(item) === null);
  const gates = data.needsYou.filter((item: any) => item.type === "gate");
  const watched = data.watch.length + claims.length;

  const permissions = data.permissions ?? [];
  const permissionDrafts = (ctx.state.permissionDrafts ??= {});
  const needs = [
    ...permissions.map((item: any) => ({
      key: `permission:${item.id}`,
      row: { icon: "lock", tone: "warning", unread: true, title: escapeHtml(item.action), meta: escapeHtml(["Permission", sessionPlace(item.initiative, item.host)].filter(Boolean).join(" · ")), end: shortTime(item.askedAt) },
      detail: permissionDetail(item, permissionDrafts[item.id] ?? {})
    })),
    ...timed.map(({ item, index }: any) => item.type !== "gate" ? { key: `note:${index}`, ...noteEntry(item, ctx) } : {
      key: `gate:${item.id}`,
      row: item.launch && item.kind === "assistance" ? { icon: "question", tone: "info", unread: true, title: escapeHtml(item.question), meta: escapeHtml([NO_RESULT_CHIP, sessionPlace(item.initiative, item.launch.host)].join(" · ")), end: shortTime(item.askedAt) } : { icon: KIND_LOOK[item.kind]?.icon ?? "question", tone: KIND_LOOK[item.kind]?.tone ?? "neutral", unread: true, title: escapeHtml(item.question), meta: escapeHtml([GATE_LABELS[item.kind] ?? item.kind, liveHolder(item) ? `${item.claim.label} is waiting on your answer` : item.slice?.title ?? item.initiative?.title ?? item.artifact?.path].filter(Boolean).join(" · ")), end: shortTime(item.askedAt) },
      detail: gateDetail(item, ctx)
    }),
    ...notes.map((item: any) => ({ key: `note:${data.needsYou.indexOf(item)}`, ...noteEntry(item, ctx) }))
  ];
  // A shipped initiative's open questions can no longer be answered, so they list apart from Needs you and raise no count.
  const shippedRows = (data.shippedGates ?? []).map((item: any) => ({
    key: `shipped:${item.id}`,
    row: { icon: KIND_LOOK[item.kind]?.icon ?? "question", tone: "neutral", title: escapeHtml(item.question), meta: escapeHtml([GATE_LABELS[item.kind] ?? item.kind, "Cannot be answered", item.slice?.title ?? item.initiative?.title ?? item.artifact?.path].filter(Boolean).join(" · ")), end: shortTime(item.askedAt) },
    detail: gateDetail(item, ctx)
  }));
  const waiting = answered.map((item: any) => ({
    key: `answered:${item.id}`,
    row: { icon: "check", tone: "success", title: escapeHtml(item.question), meta: escapeHtml(`${choiceLabel(item, item.answer.choice)} · waiting for the agent`), end: shortTime(item.answer.answeredAt) },
    detail: answeredDetail(item, ctx)
  }));
  const watch = [
    ...data.watch.map((item: any, index: number) => ({ key: `watch:${index}`, ...watchEntry(item, ctx) })),
    ...claims.map((claim: any, index: number) => ({ key: `claim:${index}`, ...claimEntry(claim, ctx) }))
  ];
  const closed = earlier.map((item: any) => ({
    key: `closed:${item.id}`,
    row: { icon: KIND_LOOK[item.kind]?.icon ?? "question", tone: "neutral", title: escapeHtml(item.question), meta: escapeHtml([GATE_LABELS[item.kind] ?? item.kind, item.answer ? choiceLabel(item, item.answer.choice) : "Closed by the agent"].join(" · ")), end: shortTime(item.closedAt) },
    detail: closedDetail(item, ctx)
  }));
  const history = [{
    key: "recent",
    row: { icon: "clock", tone: "neutral", title: "Recent changes", meta: escapeHtml(recent.length ? `${plural(recent.length, "change")} from the review app` : "No changes from the review app yet"), end: shortTime(recent[0]?.at) },
    detail: detailSheet({ className: "recent-changes-sheet", head: badge("From the review app, newest first"), title: "Recent changes", body: `<div data-recent-changes>${recent.length ? `<ul class="recent-changes">${recent.map((entry: any) => changeHtml(entry, ctx)).join("")}</ul>` : emptyState("No changes yet", "No one changed settings, answered a question, or rebuilt an index from the review app yet.")}</div>` })
  }];
  const all = [...needs, ...shippedRows, ...waiting, ...watch, ...closed, ...history];
  if (!all.some((entry) => entry.key === ctx.state.selected)) ctx.state.selected = all[0].key;
  // On a phone the list and the picked item take turns, so the page opens on the list until the person picks an item.
  ctx.state.pane ??= typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches ? "list" : "detail";
  const selected = ctx.state.selected;

  container.innerHTML = `
    <div class="attention-inbox" data-pane="${ctx.state.pane}">
      <div class="attention-list" aria-label="Items that need you">
        ${needs.length ? group("needs", "Needs you", needs, { tone: "accent" }) : `<div class="attention-nothing">${emptyState("Nothing is waiting on you", "Questions an agent asks during an orchestrated run appear here.")}</div>`}
        ${group("shipped", "Shipped history", shippedRows, { note: "These questions were left open when their initiative shipped, so they can no longer be answered." })}
        ${group("answered", "Answered", waiting)}
        ${group("watch", "Watch", watch)}
        ${closed.length ? `<prism-disclosure class="attention-earlier" summary="${escapeHtml(`Earlier questions · ${closed.length}`)}"${closed.some((entry: any) => entry.key === selected) || ctx.state.earlierOpen ? " open" : ""}><prism-inbox label="Earlier questions" data-inbox>${closed.map(({ key, row }: { key: any; row: any }) => inboxRow(key, row)).join("")}</prism-inbox></prism-disclosure>` : ""}
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
      ${stat(`${gates.length + permissions.length === 1 ? "question waits" : "questions wait"} on you`, String(gates.length + permissions.length), { tone: gates.length + permissions.length ? "accent" : "success", attributes: ' layout="inline"' })}
      ${stat(`other ${data.needsYou.length - gates.length === 1 ? "item needs" : "items need"} you`, String(data.needsYou.length - gates.length), { attributes: ' layout="inline"' })}
      ${stat(`${watched === 1 ? "thing" : "things"} to watch`, String(watched), { attributes: ' layout="inline"' })}
    </div>`);
  }

  const inbox = container.querySelector(".attention-inbox");
  const lists = [...container.querySelectorAll("[data-inbox]")];
  const show = (key: any) => {
    ctx.state.selected = key;
    for (const list of lists) list.value = key;
    for (const sheet of container.querySelectorAll("[data-detail]")) sheet.hidden = sheet.dataset.detail !== key;
  };
  show(selected);
  for (const list of lists) {
    list.addEventListener("prism-select", (event: any) => {
      show(event.detail.value);
      // On a phone the list and the detail take turns, so picking an item shows its detail.
      if (inbox.dataset.pane === "list") {
        ctx.state.pane = inbox.dataset.pane = "detail";
        container.querySelector(".attention-detail")?.scrollIntoView?.({ block: "nearest" });
      }
    });
  }
  container.querySelector(".attention-earlier")?.addEventListener("toggle", (event: any) => {
    ctx.state.earlierOpen = event.detail.open;
  });
  container.querySelector("[data-attention-back]")?.addEventListener("click", () => {
    ctx.state.pane = inbox.dataset.pane = "list";
    lists.find((list) => list.value)?.focus();
  });
  bindLinks(container, ctx);
  // The page is built out of sight and shows once drawn, so it waits for the first listing of each question's answer, Withdraw, and Continue,
  // which would otherwise move the page under the person when they arrive.
  const actionLists = [...mountAnswers(container, ctx, gates), ...mountGateActions(container, ctx)];
  bindReruns(container, ctx);
  bindPermissions(container, ctx);
  bindArchiveSession(container, ctx);
  bindDocuments(container, ctx);
  // A change applied while the page is open names its question from the questions the page shows.
  const questions = new Map([...gates, ...(data.shippedGates ?? []), ...answered, ...earlier].filter((item) => item.initiative?.id).map((item) => [`gate:${item.initiative.id}/${item.id}`, item.question]));
  followChanges(container, ctx, questions);
  container.querySelector("[data-notify]")?.addEventListener("click", () => {
    void Notification.requestPermission().finally(() => ctx.rerender());
  });
  // A redraw of Attention over itself does not wait, since the page built out of sight would lie beside the page showing, with the same forms,
  // for as long as a listing takes to read; a Withdraw or Continue that a redraw adds shows in place once read.
  return ctx.redrawing ? undefined : Promise.all(actionLists.map((list: any) => list.loaded));
}
