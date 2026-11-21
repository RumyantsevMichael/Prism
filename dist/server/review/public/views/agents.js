// Generated from src/server/review/public/views/agents.ts by scripts/native-build/compile.mjs.
import { createActionList, readOnlyNotice } from "./actions.js";
import { openQuestion } from "./attention.js";
import { coalesce } from "./poller.js";
import { badge, bindLinks, emptyState, escapeHtml } from "./util.js";
import { agoText, timeLeft } from "../kit/claim-time.js";
const EMPTY_TEXT = "No agent works on this workspace, and nothing was launched on this computer.";
const REFRESH_MS = 5e3;
const STATES = Object.freeze({
  running: ["Running", "accent"],
  waiting: ["Waiting for you", "warning"],
  blocked: ["Blocked", "warning"],
  finished: ["Finished", "success"],
  failed: ["Failed", "danger"],
  stopped: ["Stopped", "neutral"],
  working: ["Working", "info"],
  expired: ["Expired", "neutral"]
});
const GROUPS = Object.freeze([["needs-you", "Needs you"], ["launched", "Launched from Prism"], ["other", "Started outside Prism"], ["expired", "Claims that expired"], ["archived", "Archived"]]);
const SHOWS = Object.freeze([
  ["all", "All", "all", ["needs-you", "launched", "other", "expired"]],
  ["needs-you", "Needs you", "needsYou", ["needs-you"]],
  ["this-computer", "Launched from Prism", "thisComputer", ["needs-you", "launched"]],
  ["other", "Started outside Prism", "other", ["other"]],
  ["expired", "Expired", "expired", ["expired"]],
  ["archived", "Archived", "archived", ["archived"]]
]);
const ENDED_STATES = Object.freeze(["finished", "failed", "stopped", "blocked"]);
function archivable(entry) {
  return entry.kind === "launch" && entry.group !== "archived" && ENDED_STATES.includes(entry.state);
}
function archivedText(count) {
  if (count === 1) return "Archived 1 session. The Archived filter keeps it.";
  return count ? `Archived ${count} sessions. The Archived filter keeps them.` : "No ended session was left to archive.";
}
const groupAfterUnarchive = (entry) => entry.state === "failed" || entry.state === "waiting" ? "needs-you" : "launched";
const READ_ONLY_TIP = "This tab can only read.";
const EXPIRED_IN_ALL_MS = 24 * 60 * 60 * 1e3;
function runningText(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1e3));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const seconds = total % 60;
  const two = (value) => String(value).padStart(2, "0");
  if (hours) return `${hours}h ${two(minutes)}m ${two(seconds)}s`;
  if (minutes) return `${minutes}m ${two(seconds)}s`;
  return `${seconds}s`;
}
function exitText(exit) {
  if (!exit) return "";
  if (exit.signal) return `Ended by signal ${exit.signal}`;
  return exit.code === null || exit.code === void 0 ? "" : `Exit code ${exit.code}`;
}
function stateOf(entry) {
  return STATES[entry.state] ?? [String(entry.state ?? ""), "neutral"];
}
function hostText(entry) {
  return [entry.harness || "Agent", entry.model].filter(Boolean).join(" \xB7 ");
}
function agoWords(at2, now) {
  const time = Date.parse(at2 ?? "");
  if (!Number.isFinite(time)) return "";
  const seconds = Math.floor(Math.max(0, now - time) / 1e3);
  return seconds < 60 ? `${seconds}s ago` : agoText(at2, now);
}
function workText(entry, now = Date.now()) {
  if (entry.kind === "launch" && entry.state === "failed") {
    const ended = agoWords(entry.launch?.endedAt, now);
    return [ended ? `Ended ${ended}` : "", entry.reason ?? ""].filter(Boolean).join(": ");
  }
  if (entry.slice) return [entry.activity, entry.slice.title].filter(Boolean).join(" \xB7 ");
  return entry.reason ?? "";
}
const ticking = (entry) => entry.state === "running" || entry.state === "waiting";
function timeText(entry, now = Date.now(), elapsed = 0) {
  if (entry.kind === "launch") return runningText((entry.launch?.runningMs ?? 0) + (ticking(entry) ? elapsed : 0));
  if (entry.group === "expired") {
    const ago = agoText(entry.expiresAt, now);
    return ago === "just now" ? "expired just now" : ago ? `expired ${ago}` : "expired";
  }
  return timeLeft(entry.expiresAt, now).text;
}
function startText(at2, now) {
  const time = Date.parse(at2 ?? "");
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const clock = date.toLocaleTimeString(void 0, { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === date.toDateString() ? clock : `${date.toLocaleDateString(void 0, { day: "numeric", month: "short" })} ${clock}`;
}
function launchFacts(launch, now = Date.now()) {
  if (!launch) return "";
  return [launch.launchedAt ? `Started ${startText(launch.launchedAt, now)}` : "", exitText(launch.exit), launch.runs > 1 ? `${launch.runs} runs` : ""].filter(Boolean).join(" \xB7 ");
}
const at = (value) => Date.parse(value ?? "") || 0;
function order(left, right) {
  const groups = GROUPS.map(([group2]) => group2);
  const group = groups.indexOf(left.group) - groups.indexOf(right.group);
  if (group) return group;
  if (left.group === "needs-you" && left.state !== right.state) return left.state === "failed" ? -1 : right.state === "failed" ? 1 : 0;
  if (left.kind === "launch") return at(right.launch?.launchedAt) - at(left.launch?.launchedAt) || right.id.localeCompare(left.id);
  if (left.group === "other") return at(left.expiresAt) - at(right.expiresAt) || left.id.localeCompare(right.id);
  return at(right.expiresAt) - at(left.expiresAt) || left.id.localeCompare(right.id);
}
function inAll(entry, now = Date.now()) {
  if (entry.group === "archived") return false;
  return !(entry.group === "expired" && at(entry.expiresAt) && now - at(entry.expiresAt) >= EXPIRED_IN_ALL_MS);
}
function countsOf(entries, now = Date.now()) {
  const count = (accept) => entries.filter(accept).length;
  return {
    all: count((entry) => inAll(entry, now)),
    needsYou: count((entry) => entry.group === "needs-you"),
    thisComputer: count((entry) => entry.kind === "launch" && entry.group !== "archived"),
    other: count((entry) => entry.group === "other"),
    expired: count((entry) => entry.group === "expired"),
    archived: count((entry) => entry.group === "archived")
  };
}
const KIND_ICONS = { launch: "play", claim: "agent", expired: "clock" };
function titleHtml(entry, ctx) {
  const icon = entry.kind === "launch" ? KIND_ICONS.launch : entry.group === "expired" ? KIND_ICONS.expired : KIND_ICONS.claim;
  const ref = entry.kind === "launch" ? `initiative:${entry.initiative?.id}` : entry.slice?.ref ?? `initiative:${entry.initiative?.id}`;
  const facts = entry.kind === "launch" ? launchFacts(entry.launch) : "";
  const link = ref && ctx.hasArtifact(ref) ? `<a href="./review?artifact=${encodeURIComponent(ref)}" data-artifact="${escapeHtml(ref)}">${escapeHtml(entry.name ?? "")}</a>` : `<span>${escapeHtml(entry.name ?? "")}</span>`;
  return `<prism-icon class="prism-lib-kind" name="${icon}" size="sm" aria-hidden="true"></prism-icon><span class="prism-lib-title-text">${link}${facts ? `<span class="prism-lib-cell is-detail">${escapeHtml(facts)}</span>` : ""}</span>`;
}
function sessionLinkHtml(session) {
  const url = typeof session?.url === "string" && /^https:\/\/[^\s"<>]+$/i.test(session.url) ? session.url : null;
  if (!url) return "";
  const where = typeof session.label === "string" && session.label.trim() ? session.label.trim() : "";
  const tip = `Opens this session${where ? ` in ${where}` : ""} in a new tab. Only the person whose session it is can open it.`;
  return `<prism-chip class="agents-session" href="${escapeHtml(url)}" target="_blank" label="${escapeHtml(where ? `Open session in ${where}` : "Open session")}" tip="${escapeHtml(tip)}"><prism-icon slot="start" name="external"></prism-icon>Session</prism-chip>`;
}
function actionHtml(entry, writable) {
  if (entry.kind === "claim") return sessionLinkHtml(entry.session);
  if (entry.action === "answer") return '<prism-button size="sm" variant="primary" data-agent-action="answer" text="Answer"></prism-button>';
  const lock = writable ? "" : ` disabled tip="${READ_ONLY_TIP}"`;
  if (entry.action === "stop") return `<prism-button size="sm" variant="ghost" data-agent-action="stop" text="Stop"${lock}></prism-button>`;
  const open = entry.action === "open" ? '<prism-button size="sm" variant="ghost" data-agent-action="open" text="Open"></prism-button>' : "";
  if (entry.kind === "launch" && entry.group === "archived") return `${open}<prism-button size="sm" variant="ghost" data-agent-action="unarchive" text="Unarchive"${lock}></prism-button>`;
  if (archivable(entry)) return `${open}<prism-button size="sm" variant="ghost" data-agent-action="archive" text="Archive"${lock}></prism-button>`;
  return open;
}
function detailsHtml(entry) {
  const command = entry.launch?.resumeCommand;
  const reason = entry.reason && !workText(entry).includes(entry.reason) ? `<p class="agents-details-reason">${escapeHtml(entry.reason)}</p>` : "";
  if (!command) return `${reason}<p class="agents-details-lead">${ticking(entry) ? "It runs now; the command that continues it in a terminal shows once it stops." : "This session has no terminal command to continue it."}</p>`;
  return `${reason}<p class="agents-details-lead">Continue it in a terminal, in <span class="agents-folder" data-code-subject>${escapeHtml(command.cwd)}</span></p>
    <div class="agents-command"><prism-code class="agents-code"><pre><code>${escapeHtml(command.command)}</code></pre></prism-code><prism-button size="sm" variant="ghost" data-copy-command tip="Copy the command">Copy</prism-button></div>`;
}
async function render(container, entity, ctx) {
  const state = ctx.state;
  state.show = SHOWS.some(([value]) => value === state.show) ? state.show : entity.data?.show ?? "all";
  state.openAgents ??= [];
  const showChoices = SHOWS.map(([value, label]) => `<span value="${value}">${label} <span data-show-count="${value}">0</span></span>`).join("");
  const columns = ["Agent", "Host \xB7 model", "Working on", "State", "Time", ""].map((name) => `<span>${escapeHtml(name)}</span>`).join("");
  container.innerHTML = `<div class="agents">
    <div class="agents-notice" data-agents-notice></div>
    <p class="error agents-error" role="alert" hidden></p>
    <div class="agents-toolbar" data-agents-toolbar hidden><prism-segmented label="Show" value="${escapeHtml(state.show)}" wrap data-agents-show>${showChoices}</prism-segmented><prism-button class="agents-archive-ended" size="sm" data-agents-archive-ended text="Archive all ended" hidden></prism-button></div>
    <prism-lib-table class="agents-table" data-agents-table hidden><div class="prism-lib-row is-head" aria-hidden="true">${columns}</div></prism-lib-table>
    <div class="agents-none" data-agents-none hidden>${emptyState(EMPTY_TEXT)}</div>
  </div>`;
  const table = container.querySelector("[data-agents-table]");
  const headRow = table.querySelector(".prism-lib-row.is-head");
  const toolbar = container.querySelector("[data-agents-toolbar]");
  const show = container.querySelector("[data-agents-show]");
  const archiveAll = container.querySelector("[data-agents-archive-ended]");
  const empty = container.querySelector("[data-agents-none]");
  const noticeSlot = container.querySelector("[data-agents-notice]");
  const errorLine = container.querySelector(".agents-error");
  const nothing = document.createElement("p");
  nothing.className = "prism-lib-nothing";
  nothing.textContent = "No agent in this view.";
  const groupHeads = new Map(GROUPS.map(([group, label]) => {
    const head = document.createElement("div");
    head.className = "prism-lib-group";
    head.dataset.agentGroup = group;
    head.innerHTML = `<h2 class="prism-lib-group-name">${escapeHtml(label)} <prism-badge tone="neutral">0</prism-badge></h2>`;
    return [group, head];
  }));
  const rows = /* @__PURE__ */ new Map();
  const drafts = state.actionDrafts ??= {};
  let entries = [];
  let allOut = "";
  const outOfAll = (now) => entries.filter((entry) => !inAll(entry, now)).map((entry) => entry.id).join("\n");
  let loaded = false;
  let readOnly = typeof ctx.canWrite === "function" ? !ctx.canWrite() : false;
  let writes = 0;
  bindLinks(table, ctx);
  const paintArchiveAll = () => {
    if (readOnly) {
      archiveAll.setAttribute("disabled", "");
      archiveAll.setAttribute("tip", READ_ONLY_TIP);
    } else if (!archiveAll.hasAttribute("data-busy")) {
      archiveAll.removeAttribute("disabled");
      archiveAll.removeAttribute("tip");
    }
  };
  const noteReadOnly = () => {
    if (readOnly && !noticeSlot.childElementCount) noticeSlot.innerHTML = readOnlyNotice();
    paintArchiveAll();
  };
  noteReadOnly();
  const api = {
    ...ctx.actionApi,
    async list(target) {
      const listing = await ctx.actionApi.list(target);
      if (listing.writable === false && !readOnly) {
        readOnly = true;
        noteReadOnly();
        for (const row of rows.values()) paint(row);
      }
      return { ...listing, actions: (listing.actions ?? []).filter((action) => action.id !== "launch.stop") };
    },
    async apply(request) {
      try {
        return await ctx.actionApi.apply(request);
      } finally {
        void refresh();
      }
    }
  };
  const heading = (action) => ({ label: `<span class="agents-action-effect">${escapeHtml(action.effect)}</span>`, detail: "" });
  function rowFor(entry) {
    let row = rows.get(entry.id);
    if (row) return row;
    const element = document.createElement("div");
    element.className = "prism-lib-row agents-row";
    element.dataset.agent = entry.id;
    const title = document.createElement("span");
    title.className = "prism-lib-title";
    const cell = () => {
      const span = document.createElement("span");
      span.className = "prism-lib-cell";
      return span;
    };
    const host = cell();
    const work = cell();
    const badgeCell = cell();
    const time = cell();
    const clock2 = document.createElement("span");
    clock2.className = "agents-time";
    time.append(clock2);
    const action = cell();
    action.classList.add("agents-action");
    element.append(title, host, work, badgeCell, time, action);
    row = { element, cells: { title, host, work, badge: badgeCell, action }, clock: clock2, html: {}, entry, fetchedAt: Date.now(), details: null, actions: null };
    rows.set(entry.id, row);
    return row;
  }
  const isOpen = (row) => state.openAgents.includes(row.entry.id);
  function paintDetails(row) {
    if (row.entry.kind !== "launch") return;
    if (!row.details) {
      const details = document.createElement("div");
      details.className = "prism-lib-details agents-details";
      details.dataset.agentDetails = "";
      const body = document.createElement("div");
      body.className = "agents-details-body";
      const actions = document.createElement("div");
      actions.className = "agents-details-actions";
      details.append(body, actions);
      row.element.append(details);
      row.details = { element: details, body, actionsRoot: actions, html: "" };
    }
    const html = detailsHtml(row.entry);
    if (html !== row.details.html) {
      row.details.html = html;
      row.details.body.innerHTML = html;
    }
    const open = isOpen(row);
    row.details.element.hidden = !open;
    if (open && !readOnly && !row.actions) row.actions = createActionList({ root: row.details.actionsRoot, targets: [`launch:${row.entry.launch.id}`], api, drafts, heading, compact: true, notice: false, emptyText: "", unavailableButtons: true });
    if (readOnly && row.actions) {
      row.actions = null;
      row.details.actionsRoot.replaceChildren();
    }
  }
  function paint(row, now = Date.now()) {
    const { entry } = row;
    const [words, tone] = stateOf(entry);
    const html = {
      title: titleHtml(entry, ctx),
      host: escapeHtml(hostText(entry)),
      work: escapeHtml(workText(entry, now)),
      badge: badge(words, tone),
      action: actionHtml(entry, !readOnly)
    };
    for (const [key, value] of Object.entries(html)) {
      if (row.html[key] === value) continue;
      row.html[key] = value;
      row.cells[key].innerHTML = value;
    }
    const opener = row.cells.action.querySelector('[data-agent-action="open"]');
    if (opener && opener.getAttribute("aria-expanded") !== String(isOpen(row))) opener.setAttribute("aria-expanded", String(isOpen(row)));
    if (entry.kind === "launch") row.clock.dataset.runningTime = "";
    else delete row.clock.dataset.runningTime;
    const time = timeText(entry, now, now - row.fetchedAt);
    if (row.clock.textContent !== time) row.clock.textContent = time;
    paintDetails(row);
  }
  function layout(now = Date.now()) {
    entries.sort(order);
    const counts = countsOf(entries, now);
    const shown = SHOWS.find(([value]) => value === state.show)?.[3] ?? SHOWS[0][3];
    const showing = state.show === "all" || !SHOWS.some(([value]) => value === state.show) ? (entry) => inAll(entry, now) : () => true;
    allOut = outOfAll(now);
    for (const [value, , key] of SHOWS) {
      const slot = show.querySelector(`[data-show-count="${value}"]`);
      if (slot && slot.textContent !== String(counts[key])) slot.textContent = String(counts[key]);
    }
    const sequence = [headRow];
    let visibleRows = 0;
    for (const [group] of GROUPS) {
      const members = entries.filter((entry) => entry.group === group);
      const kept = new Set(members.filter(showing));
      const visible = shown.includes(group) && kept.size > 0;
      const head = groupHeads.get(group);
      head.hidden = !visible;
      const count = head.querySelector("prism-badge");
      if (count.textContent !== String(kept.size)) count.textContent = String(kept.size);
      sequence.push(head);
      for (const entry of members) {
        const row = rows.get(entry.id);
        const rowVisible = visible && kept.has(entry);
        row.element.hidden = !rowVisible;
        if (rowVisible) visibleRows += 1;
        sequence.push(row.element);
      }
    }
    nothing.hidden = visibleRows > 0;
    const offers = (shown.includes("needs-you") || shown.includes("launched")) && entries.some((entry) => shown.includes(entry.group) && showing(entry) && archivable(entry));
    if (archiveAll.hidden === offers) archiveAll.hidden = !offers;
    sequence.push(nothing);
    let previous = null;
    for (const node of sequence) {
      const expected = previous ? previous.nextElementSibling : table.firstElementChild;
      if (expected !== node) table.insertBefore(node, expected);
      previous = node;
    }
    const none = entries.length === 0;
    table.hidden = none;
    toolbar.hidden = none;
    empty.hidden = !none;
  }
  function regroup(ids, group) {
    const moved = new Set(ids);
    entries = entries.map((entry) => {
      if (!moved.has(entry.id)) return entry;
      const row = rows.get(entry.id);
      const next = { ...entry, group: typeof group === "function" ? group(entry) : group };
      if (row) {
        row.entry = next;
        paint(row);
      }
      return next;
    });
    layout();
  }
  async function send(route, body) {
    const headers = { "Content-Type": "application/json", ...typeof ctx.writeHeaders === "function" ? ctx.writeHeaders() : {} };
    const response = await fetch(`./api/agents/${route}`, { method: "POST", headers, body: JSON.stringify(body) }).catch(() => null);
    if (!response) return { status: 0, json: { message: "The review app did not answer, so nothing changed. Try again in a moment." } };
    return { status: response.status, json: await response.json().catch(() => ({ message: "The server returned an unreadable response." })) };
  }
  async function change(route, body, done) {
    const result = await send(route, body);
    if (result.status === 200) {
      writes += 1;
      done(result.json);
    } else {
      ctx.showToast(result.json?.message ?? "The change could not be made.");
    }
    void refresh();
    return result;
  }
  function showAgents(list) {
    const now = Date.now();
    const seen = /* @__PURE__ */ new Set();
    for (const entry of list) {
      seen.add(entry.id);
      const row = rowFor(entry);
      const changed = row.entry.state !== entry.state || row.entry.launch?.runs !== entry.launch?.runs;
      row.entry = entry;
      row.fetchedAt = now;
      paint(row, now);
      if (changed) void row.actions?.refresh();
    }
    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      row.element.remove();
      rows.delete(id);
    }
    state.openAgents = state.openAgents.filter((id) => seen.has(id));
    entries = [...list];
    layout();
  }
  const refresh = coalesce(async () => {
    try {
      const before = writes;
      const response = await fetch("./api/agents", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? "The agents could not be read.");
      errorLine.hidden = true;
      loaded = true;
      if (before !== writes) return void refresh();
      showAgents(Array.isArray(body.agents) ? body.agents : []);
    } catch (error) {
      errorLine.textContent = loaded ? `The list could not be refreshed: ${error.message}` : error.message;
      errorLine.hidden = false;
    }
  });
  function tick() {
    const now = Date.now();
    let moved = false;
    for (const row of rows.values()) {
      const { entry } = row;
      if (entry.kind === "claim" && entry.group === "other" && at(entry.expiresAt) && at(entry.expiresAt) <= now) {
        row.entry = { ...entry, group: "expired", state: "expired" };
        entries = entries.map((item) => item.id === entry.id ? row.entry : item);
        moved = true;
      }
      paint(row, now);
    }
    if (moved || outOfAll(now) !== allOut) layout(now);
  }
  show.addEventListener("change", (event) => {
    state.show = event.detail?.value ?? show.value;
    layout();
  });
  archiveAll.addEventListener("click", async () => {
    if (readOnly || archiveAll.hasAttribute("disabled")) return;
    archiveAll.setAttribute("data-busy", "");
    archiveAll.setAttribute("disabled", "");
    try {
      await change("archive", { ended: true }, (answer) => {
        const ids = (Array.isArray(answer?.archived) ? answer.archived : []).map((id) => `launch:${id}`);
        regroup(ids, "archived");
        ctx.showToast(archivedText(ids.length));
      });
    } finally {
      archiveAll.removeAttribute("data-busy");
      paintArchiveAll();
    }
  });
  table.addEventListener("click", async (event) => {
    const copy = event.target.closest("[data-copy-command]");
    if (copy && table.contains(copy)) {
      const command = rows.get(copy.closest("[data-agent]")?.dataset.agent)?.entry.launch?.resumeCommand;
      if (!command) return;
      try {
        await navigator.clipboard.writeText(command.command);
        ctx.showToast(`Command copied. Run it in ${command.cwd}.`);
      } catch {
        ctx.showToast("The browser could not copy the command.");
      }
      return;
    }
    const button = event.target.closest("[data-agent-action]");
    if (!button || !table.contains(button)) return;
    const row = rows.get(button.closest("[data-agent]")?.dataset.agent);
    if (!row) return;
    const what = button.dataset.agentAction;
    if (what === "answer") return openQuestion(ctx, row.entry.launch?.waitingGate ?? null);
    if (what === "open") {
      state.openAgents = isOpen(row) ? state.openAgents.filter((id) => id !== row.entry.id) : [...state.openAgents, row.entry.id];
      return paint(row);
    }
    if (what === "archive" || what === "unarchive") {
      if (readOnly || button.hasAttribute("disabled")) return;
      button.setAttribute("disabled", "");
      const id = row.entry.id;
      const result = await change(what, { launch: row.entry.launch.id }, () => {
        if (what === "archive") {
          regroup([id], "archived");
          ctx.showToast("Archived. The Archived filter keeps it.");
        } else {
          regroup([id], groupAfterUnarchive);
          ctx.showToast("Unarchived.");
        }
      });
      if (result.status !== 200) button.removeAttribute("disabled");
      return;
    }
    if (what === "stop") {
      button.setAttribute("disabled", "");
      const result = await api.apply({ action: "launch.stop", target: `launch:${row.entry.launch.id}`, input: {}, revision: null });
      if (result.status !== 200) {
        button.removeAttribute("disabled");
        ctx.showToast(result.json?.message ?? "The session could not be stopped.");
      }
    }
  });
  const clock = setInterval(() => {
    if (!container.isConnected) return clearInterval(clock);
    tick();
  }, 1e3);
  const poll = setInterval(() => {
    if (!container.isConnected) return clearInterval(poll);
    void refresh();
  }, REFRESH_MS);
  await refresh();
}
export {
  EMPTY_TEXT,
  ENDED_STATES,
  EXPIRED_IN_ALL_MS,
  GROUPS,
  REFRESH_MS,
  SHOWS,
  archivable,
  archivedText,
  countsOf,
  exitText,
  hostText,
  inAll,
  launchFacts,
  render,
  runningText,
  stateOf,
  timeText,
  workText
};
