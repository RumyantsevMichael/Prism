// Generated from src/server/review/public/views/format-migration.ts by scripts/native-build/compile.mjs.
import { badge, bindLinks, chip, escapeHtml, pageSub, plural, setPageHead, setPageSub, stat } from "./util.js";
import { findingsList } from "./format-marks.js";
const e = escapeHtml;
const POINT_QUESTIONS = Object.freeze({
  leftover: "Where does this text belong?",
  entry: "Do these entries mean the same?",
  unknown: "Which value is missing?",
  conflict: "Which definition stays?",
  "remove-source": "Prism removes the source document"
});
const POINT_KINDS = Object.freeze({ leftover: "Leftover", entry: "Same entry?", unknown: "Missing value", conflict: "Conflict", "remove-source": "Source document" });
const STATUS = Object.freeze({
  starting: ["Starting", "neutral"],
  running: ["Running", "info"],
  "waiting-for-host": ["Waits for a host", "warning"],
  asking: ["Waits for your answers", "accent"],
  continuing: ["Applying your answers", "info"],
  applied: ["Applied", "success"],
  failed: ["Failed", "danger"]
});
const CAUSE = Object.freeze({
  findings: "Prism started it because these files break their format.",
  "format-update": "Prism started it because the format changed since these files were written.",
  rerun: "Prism started it again after a run of these files failed."
});
const HOSTS = Object.freeze({ "claude-code": "Claude Code", codex: "Codex" });
const CHOICE_WORDS = Object.freeze({ same: "They mean the same", target: "Keep the target's", source: "Take the source's", remove: "Removed" });
const TEXT_MAX = 500;
const code = (text) => `<span class="run-code" data-code-subject>${e(text)}</span>`;
const liveTime = (time) => time ? `<prism-time datetime="${e(time)}"></prism-time>` : "";
const scopeWords = (scope) => scope?.label ? `in scope ${scope.label}` : "in this checkout";
const whereChip = (scope) => scope?.label ? chip(e(`Scope ${scope.label}`), { tip: "The record store scope that holds these files" }) : chip("Checkout", { tip: "Files in this checkout" });
async function rerunRun(ctx, run) {
  const target = `migration-run:${run}`;
  let action;
  try {
    action = ((await ctx.actionApi.list(target)).actions ?? []).find((item) => item.id === "migration-run.rerun");
  } catch (error) {
    ctx.showToast(error.message);
    return false;
  }
  if (!action?.available) {
    ctx.showToast(action?.reason ?? "This run cannot run again.");
    return false;
  }
  if (!await ctx.actionApi.confirm({ title: "Run the format migration again?", message: action.confirm?.message ?? action.effect })) return false;
  const answer = await ctx.actionApi.apply({ action: action.id, target, input: {}, revision: action.revision, confirmed: true });
  if (answer.status !== 200) {
    ctx.showToast(answer.json?.reason ?? answer.json?.message ?? "The run did not start again.");
    return false;
  }
  ctx.showToast("Prism started the format migration again. Its new run appears on Attention.");
  return true;
}
function head(container, run, ctx) {
  const [words, tone] = STATUS[run.status] ?? [run.status, "neutral"];
  setPageHead(container, { eyebrow: "Format migration", end: `${badge(words, tone)}${whereChip(run.scope)}` }, ctx);
  const by = run.answeredBy;
  const subs = [
    pageSub(`Run ${code(run.id)} \xB7 started ${liveTime(run.startedAt)} \xB7 ${e(CAUSE[run.cause] ?? CAUSE.findings)}`),
    by ? pageSub(`Answered by <b>${e(by.name ?? by.email ?? "an unknown person")}</b> \xB7 ${liveTime(by.at)}${by.checkout ? ` \xB7 ${e(by.checkout)}` : ""}`, { detail: true }) : "",
    run.endedAt ? pageSub(`${run.status === "failed" ? "Failed" : "Ended"} ${liveTime(run.endedAt)}`, { detail: true }) : ""
  ].filter(Boolean).join("");
  setPageSub(container, `<div class="prism-page-subs">${subs}</div>`, ctx);
}
const figures = (tiles) => `<div class="gate-evidence run-figures" role="list" aria-label="What the run holds">${tiles.map(([label, value, tone, icon]) => `<span role="listitem">${stat(label, String(value), { tone, attributes: ` layout="figure" icon="${icon}"` })}</span>`).join("")}</div>`;
const askedOf = (migration) => migration.points.filter((point) => point.asked);
const settledOf = (migration) => migration.points.filter((point) => point.settled);
const recommendationOf = (point) => point.kind === "entry" || point.kind === "conflict" ? point.asked.recommended : point.asked.recommendation ?? "";
const subjectOf = (point) => point.kind === "leftover" ? point.statement : point.kind === "unknown" ? point.field : point.kind === "remove-source" ? null : point.entry;
function entryText(label, text) {
  return `<span class="run-entry-label">${e(label)}</span><span class="run-entry" data-code-subject>${e(text ?? "")}</span>`;
}
function recommendationLine(point) {
  return `<p class="run-recommendation"><prism-icon name="info" size="sm" tone="accent"></prism-icon><span><b>Prism recommends</b> ${e(point.asked.recommendation)}</span></p>`;
}
function option(point, value, title, detail) {
  const recommended = point.asked.recommended === value ? ' <prism-badge tone="accent">Recommended</prism-badge>' : "";
  return `<prism-choice-option value="${e(value)}">${e(title)}${recommended}<span slot="detail">${detail}</span></prism-choice-option>`;
}
function control(point, migration, value) {
  const attributes = `data-answer-field="${e(point.id)}" data-recommended="${e(recommendationOf(point))}"`;
  switch (point.kind) {
    case "leftover":
      return `<blockquote class="run-quote"><span>${e(point.statement)}</span>${Number.isInteger(point.sourceLine) ? `<span class="muted">Line ${point.sourceLine} of the source</span>` : ""}</blockquote>
        <prism-field type="textarea" label="Its home" ${attributes} value="${e(value)}" required hint="Prism's recommendation, sent as it is unless you change it. 1 to ${TEXT_MAX} characters."></prism-field>`;
    case "unknown": {
      const status = migration.status ?? "migrated";
      const hint = point.allowsUnknown ? `This ${status} file may say unknown until someone knows. Line ${point.line} of the migrated file.` : `This ${status} file needs a real value: unknown is not allowed. Line ${point.line} of the migrated file.`;
      return `${recommendationLine(point)}
        <prism-field type="text" label="${e(point.field)}" ${attributes} data-allows-unknown="${point.allowsUnknown ? "true" : "false"}" value="${e(value)}" required hint="${e(hint)}"></prism-field>`;
    }
    case "entry":
      return `${recommendationLine(point)}
        <div class="run-sides"><div class="run-side">${entryText("The target's entry now", point.targetText)}</div><div class="run-side">${entryText("The source's entry", point.sourceText)}</div></div>
        <prism-choice label="Your answer" ${attributes} value="${e(value)}">
          ${option(point, "same", "They mean the same", "The target keeps its words; the source's text counts as kept.")}
          ${option(point, "target", "They differ: keep the target's", "The target's entry stays as it is.")}
          ${option(point, "source", "They differ: take the source's", "The source's text replaces the target's entry.")}
        </prism-choice>`;
    case "conflict":
      return `${recommendationLine(point)}
        <div class="run-sides"><div class="run-side">${entryText("In the target now", point.targetText)}</div><div class="run-side">${entryText("From the source", point.sourceText)}</div></div>
        <prism-choice label="Your answer" ${attributes} value="${e(value)}">
          ${option(point, "target", "Keep the target's definition", "The target's entry stays as it is.")}
          ${option(point, "source", "Take the source's definition", "The source's version replaces the target's entry.")}
        </prism-choice>`;
    case "remove-source":
      return `<p class="run-recommendation"><prism-icon name="info" size="sm" tone="accent"></prism-icon><span>Every statement of ${code(migration.source.path)} now has a home in ${code(migration.target.path)} or in a leftover's home, so Prism removes ${code(migration.source.path)} when it applies the run.</span></p>`;
    default:
      return "";
  }
}
function pointBlock(point, migration, total, drafts) {
  const subject = subjectOf(point);
  const value = Object.hasOwn(drafts, point.id) ? drafts[point.id] : recommendationOf(point);
  const subjectHtml = point.kind === "remove-source" ? ` ${code(migration.source.path)}` : point.kind === "leftover" ? "" : subject ? ` <span class="run-point-subject">${e(subject)}</span>` : "";
  return `<section class="run-point" id="point-${e(point.id)}" data-point="${e(point.id)}" aria-labelledby="point-${e(point.id)}-question">
    <div class="run-point-head"><span class="label-caps">Point ${point.number ?? "?"} of ${total}</span>${chip(e(POINT_KINDS[point.kind] ?? point.kind))}<prism-chip tone="accent" data-changed hidden>Changed from Prism's recommendation</prism-chip></div>
    <h4 class="run-point-question" id="point-${e(point.id)}-question">${e(POINT_QUESTIONS[point.kind] ?? point.kind)}${subjectHtml}</h4>
    ${control(point, migration, value)}
  </section>`;
}
function answerWords(point) {
  const answer = point.answer;
  if (!answer) return { given: "", changed: false };
  if (point.kind === "remove-source") return { given: "The source is removed", changed: false };
  if (point.kind === "entry" || point.kind === "conflict") return { given: CHOICE_WORDS[answer.choice] ?? String(answer.choice ?? ""), changed: answer.choice !== point.asked?.recommended };
  return { given: String(answer.value ?? ""), changed: answer.value !== point.asked?.recommendation };
}
function answeredRows(migration) {
  return `<div class="prism-rows" role="list" aria-label="Answered by you">${askedOf(migration).map((point) => {
    const { given, changed } = answerWords(point);
    const subject = point.kind === "remove-source" ? "The source document" : subjectOf(point);
    const by = point.answer?.by?.name ?? point.answer?.by?.email ?? "you";
    const advised = point.kind === "entry" || point.kind === "conflict" ? CHOICE_WORDS[point.asked.recommended] : point.asked.recommendation;
    return `<prism-row wrap icon="${changed ? "forward" : "check-circle"}" tone="${changed ? "accent" : "success"}">${e(POINT_QUESTIONS[point.kind] ?? point.kind)} <span class="run-point-subject">${e(subject ?? "")}</span><span slot="description">${e(POINT_KINDS[point.kind] ?? point.kind)} \xB7 answered by ${e(by)}</span><span slot="detail"><b>${e(given)}</b>${changed ? `<br><span class="muted">Prism recommended: ${e(advised ?? "")}</span>` : ""}</span><prism-chip slot="kind" tone="${changed ? "accent" : "success"}">${changed ? "Changed" : "As recommended"}</prism-chip>${point.answer?.at ? `<prism-time slot="time" format="short" datetime="${e(point.answer.at)}"></prism-time>` : ""}</prism-row>`;
  }).join("")}</div>`;
}
function settledRows(migration) {
  const settled = settledOf(migration);
  if (!settled.length) return '<p class="muted run-quiet-note">Prism settled no point of this file itself: every statement kept its place.</p>';
  return `<div class="prism-rows" role="list" aria-label="Settled by Prism">${settled.map((point) => `<prism-row wrap icon="check" tone="success">${e(subjectOf(point) ?? POINT_KINDS[point.kind])}<span slot="description">${e(POINT_KINDS[point.kind] ?? point.kind)}</span><span slot="detail"><b>Prism's reason:</b> ${e(point.settled.reason)}</span><prism-chip slot="kind" tone="success">Settled by Prism</prism-chip></prism-row>`).join("")}</div>`;
}
function landed(statement, migration, asking) {
  const where = statement.landed;
  const point = where.point ? migration.points.find((item) => item.id === where.point) : null;
  const settled = point?.settled ? ` ${chip("Settled by Prism", { tone: "success" })}` : "";
  if (point?.asked && asking) return `<a class="run-point-link" href="#point-${e(point.id)}" data-point-link="${e(point.id)}">${chip(e(`Asks you \xB7 point ${point.number}`), { tone: "accent" })}</a>`;
  if (where.kind === "leftover") {
    const home = point?.answer?.value ?? where.home;
    return `<span class="run-landed">${chip("Leftover", { tone: "warning" })}<span>Home: ${e(home)}</span>${settled}</span>`;
  }
  if (where.kind === "entry") {
    const choice = point?.answer?.choice ?? (point?.settled ? "same" : null);
    const words = choice === "source" ? "the source's text" : choice === "same" ? "the same entry, in the target's words" : "the target's text";
    return `<span class="run-landed"><span>${e(`Entry ${where.entry} \xB7 ${words}`)}</span>${settled}</span>`;
  }
  if (where.kind === "conflict") {
    const words = point?.answer?.choice === "source" ? "the source's definition" : "the target's definition";
    return `<span class="run-landed"><span>${e(`Entry ${where.entry} \xB7 ${words}`)}</span>${settled}</span>`;
  }
  return `<span class="run-landed"><span>${e(where.heading ?? "Before the first section")}</span>${settled}</span>`;
}
function statementMap(migration, asking) {
  const map = migration.map;
  if (!map) return '<p class="muted">This proposal was recorded without its source, so its statement map cannot be shown.</p>';
  const rows = map.statements.map((statement) => `<div class="prism-lib-row"><span class="prism-lib-cell run-line">L${statement.line}</span><span class="run-statement">${e(statement.text)}</span><span>${landed(statement, migration, asking)}</span></div>`).join("");
  const added = map.added.map((line) => `<div class="prism-lib-row"><span class="prism-lib-cell run-line">+${line.line}</span><span>${code(line.text)}</span><span class="prism-lib-cell">${e(line.what)}</span></div>`).join("");
  return `<prism-lib-table class="run-map">
    <div class="prism-lib-row is-head" aria-hidden="true"><span>Line</span><span>Source statement</span><span>Where it landed</span></div>
    <div class="prism-lib-group"><h2 class="prism-lib-group-name">Statements of the source <prism-badge tone="neutral">${map.statements.length}</prism-badge></h2><span class="prism-lib-group-source">word for word, in source order</span></div>
    ${rows || '<p class="prism-lib-nothing">The source holds no statement.</p>'}
    ${map.added.length ? `<div class="prism-lib-group"><h2 class="prism-lib-group-name">Added by the format <prism-badge tone="neutral">${map.added.length}</prism-badge></h2><span class="prism-lib-group-source">structure, defaults, and values the source never gave, no new statement</span></div>${added}` : ""}
  </prism-lib-table>`;
}
const mapSummary = (migration) => migration.map ? `Statement map \xB7 ${plural(migration.map.statements.length, "statement")}${migration.map.added.length ? `, ${migration.map.added.length} added by the format` : ""}` : "Statement map";
function fileHead(migration) {
  const paths = migration.separateSource ? `${code(migration.source.path)} <span class="muted">into</span> ${code(migration.target.path)}` : code(migration.target.path);
  const decided = migration.status === "Approved" || migration.status === "Accepted";
  const status = migration.status ? chip(`${e(migration.status)}${decided ? `<span slot="meta">stays ${e(migration.status)}</span>` : ""}`, { tone: decided ? "success" : "warning" }) : "";
  return `<header class="run-file-head"><h3 class="run-file-path">${paths}</h3><div class="run-file-chips">${status}</div></header>`;
}
function fileCard(migration, run, mode, { openMap = false, drafts = {} } = {}) {
  const asked = askedOf(migration);
  const points = mode === "ask" && asked.length ? `<div class="run-points">${asked.map((point) => pointBlock(point, migration, run.points, drafts)).join("")}</div>` : "";
  const answered = mode === "result" && asked.length && asked.some((point) => point.answer) ? `<div class="run-answered"><p class="label-caps">Answered by you</p>${answeredRows(migration)}</div>` : "";
  const settledOpen = mode === "result" && openMap && settledOf(migration).length > 0;
  return `<section class="run-file" aria-label="${e(migration.target.path)}">
    ${fileHead(migration)}
    <p class="run-file-summary">${e(migration.summary)}</p>
    ${points}
    ${answered}
    <prism-disclosure class="run-map-toggle" summary="${e(mapSummary(migration))}"${openMap ? " open" : ""}>${statementMap(migration, mode === "ask")}</prism-disclosure>
    ${settledOf(migration).length ? `<prism-disclosure summary="${e(`Settled by Prism \xB7 ${plural(settledOf(migration).length, "point")}`)}"${settledOpen ? " open" : ""}>${settledRows(migration)}</prism-disclosure>` : ""}
  </section>`;
}
function quietGroup(run, files, mode, label) {
  if (!files.length) return "";
  const note = mode === "ask" ? "Prism settled everything in these files itself. They apply together with the rest when you send your answers." : "Prism settled everything in these files itself.";
  return `<prism-disclosure class="run-quiet" summary="${e(label)}"><p class="muted run-quiet-note">${e(note)}</p><div class="run-files">${files.map((migration) => fileCard(migration, run, mode)).join("")}</div></prism-disclosure>`;
}
function setRows(run) {
  return `<section class="run-section" aria-labelledby="run-set"><h2 class="run-section-title" id="run-set">Files in the run <prism-badge tone="neutral">${run.artifacts.length}</prism-badge></h2>
    <div class="prism-rows" role="list" aria-label="Files in the run">${run.artifacts.map((artifact) => {
    const rules = [...new Set((artifact.findings ?? []).map((finding) => finding.rule))];
    const description = artifact.findings === null ? "No longer held where the run found it" : rules.length ? `Breaks ${rules.join(", ")}` : "Keeps its format now";
    return `<prism-row wrap icon="document" tone="neutral">${code(artifact.path)}<span slot="description">${e(description)}</span>${(artifact.findings ?? []).length ? `<span slot="detail">${findingsList(artifact.findings)}</span>` : ""}</prism-row>`;
  }).join("")}</div></section>`;
}
function askingPage(run, drafts) {
  const withPoints = run.migrations.filter((migration) => askedOf(migration).length);
  const quiet = run.migrations.filter((migration) => !askedOf(migration).length);
  const settled = run.migrations.reduce((sum, migration) => sum + settledOf(migration).length, 0);
  const single = run.migrations.length === 1;
  return `${figures([
    [single ? "file in the run" : "files in the run", run.migrations.length, "", "layers"],
    [quiet.length === 1 ? "applies without a question" : "apply without a question", quiet.length, "success", "check"],
    [`${run.points === 1 ? "point asks" : "points ask"} you, in ${plural(withPoints.length, "file")}`, run.points, "accent", "question"],
    [settled === 1 ? "point Prism settled itself" : "points Prism settled itself", settled, "", "check-circle"]
  ])}
    <prism-banner tone="info" heading="One answer settles the whole run"><p>Prism could not settle the points below on its own. Each already holds Prism's recommendation, so you change only what you disagree with. Prism then applies every file of the run together, or none of them.</p></prism-banner>
    <section class="run-section" aria-labelledby="run-asks"><h2 class="run-section-title" id="run-asks">Asks you <prism-badge tone="accent">${run.points}</prism-badge></h2>
      <div class="run-files">${withPoints.map((migration) => fileCard(migration, run, "ask", { openMap: single, drafts })).join("")}</div>
    </section>
    ${quietGroup(run, quiet, "ask", `${plural(quiet.length, "file")} without a question`)}
    <div class="run-answer-bar" data-answer-bar>
      <p class="gate-hint" aria-live="polite"><prism-icon name="check-circle" size="sm"></prism-icon><span class="gate-hint-text" data-hint></span></p>
      <p class="error run-error" role="alert" data-answer-error hidden></p>
      <prism-button variant="primary" data-send>Send answers</prism-button>
    </div>`;
}
function appliedPage(run) {
  const single = run.migrations.length === 1;
  const withAnswers = run.migrations.filter((migration) => askedOf(migration).length);
  const quiet = run.migrations.filter((migration) => !askedOf(migration).length);
  const settled = run.migrations.reduce((sum, migration) => sum + settledOf(migration).length, 0);
  const changed = run.migrations.flatMap(askedOf).filter((point) => answerWords(point).changed).length;
  const store = run.migrations.some((migration) => migration.target.scope);
  const decided = run.migrations.some((migration) => migration.target.scope && (migration.status === "Approved" || migration.status === "Accepted"));
  const where = store ? `Prism wrote the files to the store and committed them as one change of their own, ${code(`prism: format migration ${run.id}`)}.${decided ? " Each decided file keeps its status, and its accepted version is now the migrated file." : ""}` : `Prism wrote ${single ? "the file" : "the files"} into this checkout's working tree and left ${single ? "it" : "them"} uncommitted, for you to commit with your own work.`;
  return `<prism-banner tone="success" heading="${e(`Applied: ${plural(run.migrations.length, "file")} now ${single ? "keeps" : "keep"} the format`)}"><p>${where}</p></prism-banner>
    ${figures([
    [single ? "file migrated" : "files migrated", run.migrations.length, "success", "check"],
    [settled === 1 ? "point Prism settled itself" : "points Prism settled itself", settled, "", "check-circle"],
    [run.points === 1 ? "point you answered" : "points you answered", run.points, run.points ? "accent" : "", "question"],
    [changed === 1 ? "answer changed Prism's recommendation" : "answers changed Prism's recommendation", changed, "", "forward"]
  ])}
    ${withAnswers.length ? `<section class="run-section" aria-labelledby="run-answered"><h2 class="run-section-title" id="run-answered">Files with your answers <prism-badge tone="neutral">${withAnswers.length}</prism-badge></h2><div class="run-files">${withAnswers.map((migration) => fileCard(migration, run, "result", { openMap: single })).join("")}</div></section>` : ""}
    ${single && quiet.length ? `<section class="run-section" aria-label="The migrated file"><div class="run-files">${fileCard(quiet[0], run, "result", { openMap: true })}</div></section>` : quietGroup(run, quiet, "result", `${plural(quiet.length, "file")} Prism settled alone`)}`;
}
function failedPage(run, ctx) {
  const reason = run.failure?.reason ?? "The run failed without a reason.";
  const rerun = run.followedBy ? `<p class="muted run-rerun-note">A later run of these files follows this one: ${ctx.hasArtifact(`migration-run:${run.followedBy}`) ? `<a href="./review?artifact=${encodeURIComponent(`migration-run:${run.followedBy}`)}" data-artifact="${e(`migration-run:${run.followedBy}`)}">open the later run</a>` : e(run.followedBy)}.</p>` : `<div class="run-rerun gate-actions"><p class="gate-hint muted"><span class="gate-hint-text">Running it again starts this format migration of the same files again, apart from every other task.</span></p><prism-button variant="primary" data-rerun>Run again</prism-button></div>`;
  return `<prism-banner tone="danger" heading="The run failed, so nothing changed"><p class="run-reason">${e(reason)}</p></prism-banner>
    ${rerun}
    ${setRows(run)}`;
}
function waitingPage(run) {
  return `<prism-banner tone="warning" heading="The run waits for a host"><p class="run-reason">${e(run.reason ?? "No host is available on this machine.")}</p><p>Prism starts the run on its own the next time it checks this project on a computer where Claude Code or Codex is available.</p></prism-banner>
    ${setRows(run)}`;
}
function workingPage(run) {
  const host = HOSTS[run.launch?.host] ?? "A host";
  const heading = run.status === "continuing" ? "Prism applies your answers" : run.status === "starting" ? "Prism is starting the run" : `${host} is migrating these files`;
  const text = run.status === "continuing" ? "The run's session goes on with your answers. The page updates when the run applies or fails." : "The page updates when the run applies, asks you, or fails.";
  return `<prism-banner tone="info" heading="${e(heading)}"><p>${e(text)}</p></prism-banner>
    ${setRows(run)}`;
}
const fieldValue = (field) => String(field.value ?? field.getAttribute("value") ?? "");
function bindAnswer(container, run, ctx, drafts) {
  const bar = container.querySelector("[data-answer-bar]");
  if (!bar) return;
  const fields = [...container.querySelectorAll("[data-answer-field]")];
  const send = bar.querySelector("[data-send]");
  const hint = bar.querySelector("[data-hint]");
  const failure = bar.querySelector("[data-answer-error]");
  let sending = false;
  for (const field of fields) if (field.control) field.control.maxLength = TEXT_MAX;
  const problemOf = (field) => {
    const value = fieldValue(field).trim();
    if (field.tagName === "PRISM-CHOICE") return value ? null : "Choose an answer.";
    if (!value) return "Give a value, or the run cannot apply.";
    if (value.length > TEXT_MAX) return `Keep it to ${TEXT_MAX} characters.`;
    if (field.dataset.allowsUnknown === "false" && /[\r\n]/.test(value)) return "Write the value on one line.";
    if (field.dataset.allowsUnknown === "false" && value.toLowerCase() === "unknown") return "This file needs a real value, so unknown cannot stay.";
    if (field.dataset.allowsUnknown === "true" && /[\r\n]/.test(value)) return "Write the value on one line.";
    return null;
  };
  const refresh = () => {
    let changed = 0;
    let missing = 0;
    for (const field of fields) {
      const value = fieldValue(field).trim();
      const differs = value !== field.dataset.recommended;
      if (differs) changed += 1;
      const problem = problemOf(field);
      if (problem) missing += 1;
      if (field.tagName === "PRISM-FIELD") {
        field.toggleAttribute("invalid", Boolean(problem));
        if (problem) field.setAttribute("error", problem);
        else field.removeAttribute("error");
      }
      const mark = field.closest("[data-point]")?.querySelector("[data-changed]");
      if (mark) mark.hidden = !differs;
    }
    const ready = !missing && !sending;
    const count = run.points;
    hint.textContent = missing ? missing === 1 ? "One value is missing before you can send." : `${missing} values are missing before you can send.` : `${plural(count, "point")}, ${changed ? `${changed} changed from Prism's recommendation.` : "all as Prism recommends."}`;
    const line = hint.closest(".gate-hint");
    line.classList.toggle("is-ready", !missing);
    line.querySelector("prism-icon").hidden = Boolean(missing);
    send.toggleAttribute("disabled", !ready);
  };
  const remember = (event) => {
    const field = event.target.closest?.("[data-answer-field]");
    if (!field) return;
    drafts[field.dataset.answerField] = fieldValue(field);
    failure.hidden = true;
    refresh();
  };
  container.addEventListener("input", remember);
  container.addEventListener("change", remember);
  void customElements.whenDefined("prism-choice").then(() => requestAnimationFrame(refresh));
  refresh();
  send.addEventListener("click", async () => {
    if (sending || send.hasAttribute("disabled")) return;
    const target = `migration-run:${run.id}`;
    const fail = (message) => {
      failure.textContent = message;
      failure.hidden = false;
      sending = false;
      refresh();
    };
    sending = true;
    refresh();
    let action;
    try {
      action = ((await ctx.actionApi.list(target)).actions ?? []).find((item) => item.id === "migration-run.answer");
    } catch (error) {
      fail(error.message);
      return;
    }
    if (!action?.available) {
      fail(action?.reason ?? "The run takes no answer now.");
      ctx.rerender();
      return;
    }
    if (!await ctx.actionApi.confirm({ title: "Send your answers?", message: action.confirm?.message ?? action.effect })) {
      sending = false;
      refresh();
      return;
    }
    const names = new Set((action.fields ?? []).map((field) => field.name));
    const input = Object.fromEntries(fields.filter((field) => names.has(field.dataset.answerField)).map((field) => [field.dataset.answerField, fieldValue(field).trim()]));
    const answer = await ctx.actionApi.apply({ action: action.id, target, input, revision: action.revision, confirmed: true });
    if (answer.status !== 200) {
      fail(answer.json?.reason ?? answer.json?.message ?? "The answers were not recorded.");
      return;
    }
    for (const key of Object.keys(drafts)) delete drafts[key];
    ctx.showToast("Answers recorded. Prism continues the run with them and applies every file together, or none.");
    ctx.rerender();
  });
}
function bindPointLinks(container) {
  container.addEventListener("click", (event) => {
    const link = event.target.closest?.("[data-point-link]");
    if (!link) return;
    event.preventDefault();
    const point = container.querySelector(`[data-point="${CSS.escape(link.dataset.pointLink)}"]`);
    point?.scrollIntoView({ block: "start", behavior: "smooth" });
    point?.querySelector("[data-answer-field]")?.focus?.();
  });
}
function render(container, entity, ctx) {
  const run = entity.data;
  head(container, run, ctx);
  const drafts = ctx.state.answers ??= {};
  const asking = run.status === "asking" && !run.answeredBy;
  const body = asking ? askingPage(run, drafts) : run.status === "applied" ? appliedPage(run) : run.status === "failed" ? failedPage(run, ctx) : run.status === "waiting-for-host" ? waitingPage(run) : workingPage(run);
  container.innerHTML = `<div class="run-view" data-run="${e(run.status)}">${body}</div>`;
  bindLinks(container, ctx);
  bindPointLinks(container);
  if (asking) bindAnswer(container, run, ctx, drafts);
  container.querySelector("[data-rerun]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.toggleAttribute("disabled", true);
    if (await rerunRun(ctx, run.id)) ctx.rerender();
    else button.toggleAttribute("disabled", false);
  });
}
export {
  POINT_KINDS,
  POINT_QUESTIONS,
  render,
  rerunRun,
  scopeWords,
  whereChip
};
