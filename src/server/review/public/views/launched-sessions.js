import { createActionList, readOnlyNotice } from "./actions.js";
import { coalesce } from "./poller.js";
import { artifactLink, badge, bindLinks, emptyState, escapeHtml, formatTime, keyValues } from "./util.js";

// The Launched sessions place: one row per headless session that Prism started on this computer for this checkout's records,
// read from api/launches every few seconds, with each row's stop and resume actions drawn by the generic action controls.

export const EMPTY_TEXT = "Nothing launched on this computer yet. Launch an initiative from its page.";
export const REFRESH_MS = 5000;

const STATES = Object.freeze({
  running: ["Running", "accent"],
  waiting: ["Waiting for you", "warning"],
  blocked: ["Blocked", "warning"],
  finished: ["Finished", "success"],
  failed: ["Failed", "danger"],
  stopped: ["Stopped", "neutral"]
});

/** A duration in milliseconds as hours, minutes, and seconds, such as `4s`, `2m 05s`, or `1h 02m 09s`. */
export function runningText(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value) => String(value).padStart(2, "0");
  if (hours) return `${hours}h ${two(minutes)}m ${two(seconds)}s`;
  if (minutes) return `${minutes}m ${two(seconds)}s`;
  return `${seconds}s`;
}

/** How the last run ended, as the host reported it, or an empty text while no run has ended. */
export function exitText(exit) {
  if (!exit) return "";
  if (exit.signal) return `Ended by signal ${exit.signal}`;
  return exit.code === null || exit.code === undefined ? "" : `Exit code ${exit.code}`;
}

/** The state's words and the tone of its badge. */
export function stateOf(launch) {
  return STATES[launch.state] ?? [String(launch.state ?? ""), "neutral"];
}

// The part of a row that the listing decides; the running time's text is left to the clock, so a second that passes never redraws the row.
function infoHtml(launch, title, ctx) {
  const [stateText, tone] = stateOf(launch);
  const facts = keyValues([
    ["Host", escapeHtml(launch.hostLabel)],
    ["Launched", `<time datetime="${escapeHtml(launch.launchedAt)}">${escapeHtml(formatTime(launch.launchedAt))}</time>`],
    ["Running time", '<span class="launch-running" data-running-time></span>'],
    ["Runs", launch.runs > 1 ? escapeHtml(String(launch.runs)) : ""],
    ["Exit status", escapeHtml(exitText(launch.exit))]
  ]);
  const command = launch.resumeCommand;
  const resume = command
    ? `<div class="launch-resume">
        <p class="launch-resume-lead">Continue it in a terminal, in <span class="launch-folder" data-code-subject>${escapeHtml(command.cwd)}</span></p>
        <div class="launch-command"><prism-code class="launch-code"><pre><code>${escapeHtml(command.command)}</code></pre></prism-code><prism-button size="sm" variant="ghost" data-copy-command tip="Copy the command">Copy</prism-button></div>
      </div>`
    : "";
  return `<div class="launch-head">
      <h2 class="launch-title">${artifactLink(`initiative:${launch.initiative}`, ctx, title)}</h2>
      ${badge(stateText, tone)}
    </div>
    ${launch.reason ? `<p class="launch-reason">${escapeHtml(launch.reason)}</p>` : ""}
    ${facts}
    ${resume}`;
}

// A session's run is running while its Stop action is available; until its listing arrives, a running state says so.
function ticking(row) {
  const { state } = row.launch;
  if (row.stoppable !== null) return row.stoppable;
  return state === "running" || state === "waiting";
}

export async function render(container, entity, ctx) {
  const titles = entity.data?.titles ?? {};
  container.innerHTML = '<div class="launches"><div class="launches-notice" data-launches-notice></div><p class="error launches-error" role="alert" hidden></p><div class="launches-list" data-launch-list></div></div>';
  const list = container.querySelector("[data-launch-list]");
  const noticeSlot = container.querySelector("[data-launches-notice]");
  const errorLine = container.querySelector(".launches-error");
  const rows = new Map();
  const drafts = (ctx.state.actionDrafts ??= {});
  let readOnly = false;
  let loaded = false;
  bindLinks(list, ctx);

  const api = (row) => ({
    ...ctx.actionApi,
    async list(target) {
      const listing = await ctx.actionApi.list(target);
      row.stoppable = Boolean(listing.actions?.find((action) => action.id === "launch.stop")?.available);
      if (listing.writable === false && !readOnly) {
        readOnly = true;
        noticeSlot.innerHTML = readOnlyNotice();
      }
      tick();
      return listing;
    },
    async apply(request) {
      try {
        return await ctx.actionApi.apply(request);
      } finally {
        void refresh();
      }
    }
  });

  // An available action reads as what it does beside its button, and an unavailable one as its name beside the reason.
  const heading = (action) => ({ label: action.available ? `<span class="launch-action-effect">${escapeHtml(action.effect)}</span>` : escapeHtml(action.label), detail: "" });

  function rowFor(launch) {
    let row = rows.get(launch.id);
    if (row) return row;
    const element = document.createElement("prism-panel");
    element.className = "view-section launch-row";
    element.dataset.launch = launch.id;
    const info = document.createElement("div");
    info.className = "launch-info";
    const actions = document.createElement("div");
    actions.className = "launch-actions";
    element.append(info, actions);
    row = { element, info, html: "", launch, stoppable: null, fetchedAt: Date.now(), actions: null };
    rows.set(launch.id, row);
    row.actions = createActionList({ root: actions, targets: [`launch:${launch.id}`], api: api(row), drafts, heading, compact: true, notice: false, emptyText: "" });
    return row;
  }

  function tick() {
    const now = Date.now();
    for (const row of rows.values()) {
      const clock = row.info.querySelector("[data-running-time]");
      if (!clock) continue;
      const text = runningText(row.launch.runningMs + (ticking(row) ? now - row.fetchedAt : 0));
      if (clock.textContent !== text) clock.textContent = text;
    }
  }

  function show(launches) {
    const now = Date.now();
    const seen = new Set();
    let previous = null;
    for (const launch of launches) {
      seen.add(launch.id);
      const row = rowFor(launch);
      const changed = row.launch.state !== launch.state || row.launch.runs !== launch.runs;
      row.launch = launch;
      row.fetchedAt = now;
      const html = infoHtml(launch, titles[launch.initiative] ?? launch.initiative, ctx);
      if (html !== row.html) {
        row.html = html;
        row.info.innerHTML = html;
      }
      if (changed) void row.actions.refresh();
      // A row moves only when the order changed, so a focused control keeps its focus.
      const expected = previous ? previous.nextElementSibling : list.firstElementChild;
      if (expected !== row.element) list.insertBefore(row.element, expected);
      previous = row.element;
    }
    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      row.element.remove();
      rows.delete(id);
    }
    const empty = list.querySelector(":scope > prism-empty-state");
    if (!launches.length && !empty) list.insertAdjacentHTML("beforeend", emptyState(EMPTY_TEXT));
    if (launches.length && empty) empty.remove();
    tick();
  }

  // One read at a time; a read asked for while one is on its way runs once after it.
  const refresh = coalesce(async () => {
    try {
      const response = await fetch("./api/launches", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? "The launched sessions could not be read.");
      errorLine.hidden = true;
      loaded = true;
      show(Array.isArray(body.launches) ? body.launches : []);
    } catch (error) {
      errorLine.textContent = loaded ? `The list could not be refreshed: ${error.message}` : error.message;
      errorLine.hidden = false;
    }
  });

  list.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy-command]");
    if (!button || !list.contains(button)) return;
    const row = rows.get(button.closest("[data-launch]")?.dataset.launch);
    const command = row?.launch.resumeCommand;
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command.command);
      ctx.showToast(`Command copied. Run it in ${command.cwd}.`);
    } catch {
      ctx.showToast("The browser could not copy the command.");
    }
  });

  // The clock and the refresh stop once the place left the page.
  const clock = setInterval(() => {
    if (!container.isConnected) return clearInterval(clock);
    tick();
  }, 1000);
  const poll = setInterval(() => {
    if (!container.isConnected) return clearInterval(poll);
    void refresh();
  }, REFRESH_MS);
  await refresh();
}
