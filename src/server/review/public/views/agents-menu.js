// The top bar's agents button and its short menu, read from api/agents: the button counts the working agents and marks failed and waiting launched sessions,
// and the menu lists only the launched sessions that need the person, counts the rest, and leads to the Agents page. Nothing here takes, releases, or renews a claim.
import { hostText, runningText, stateOf, workText } from "./agents.js";
import { createPoller } from "./poller.js";
import { badge, escapeHtml } from "./util.js";

export const REFRESH_MS = 5000;

// The menu's count links: their words, the count of api/agents each shows, their glyph, and the Agents page address each opens.
const COUNT_LINKS = Object.freeze([
  ["Launched on this computer", "thisComputer", "play", "agents:this-computer"],
  ["Other sessions", "other", "agent", "agents:other"],
  ["Expired claims", "expired", "clock", "agents:expired"]
]);

const ticking = (entry) => entry.state === "running" || entry.state === "waiting";

/** The second line of a row: the harness or Agent, the model, and what the session works on. */
export function rowDescription(entry, now = Date.now()) {
  return [hostText(entry), workText(entry, now)].filter(Boolean).join(" · ");
}

function rowHtml(entry, now) {
  const [words, tone] = stateOf(entry);
  const answer = entry.action === "answer";
  const action = answer ? '<prism-button slot="action" size="sm" variant="primary" data-menu-action="answer" text="Answer"></prism-button>' : '<prism-button slot="action" size="sm" variant="ghost" data-menu-action="open" text="Open"></prism-button>';
  return `<prism-row icon="play" tone="${escapeHtml(tone)}" data-menu-agent="${escapeHtml(entry.id)}">${escapeHtml(entry.name ?? "")}<span slot="description" data-menu-description>${escapeHtml(rowDescription(entry, now))}</span>${badge(words, tone).replace("<prism-badge", '<prism-badge slot="kind"')}<span slot="time" data-menu-time>${escapeHtml(runningText(entry.launch?.runningMs ?? 0))}</span>${action}</prism-row>`;
}

/**
 * Keeps `button`, a prism-agent-summary, and `popover`, its prism-popover, in step with api/agents, every five seconds while the tab is shown and at once through `refresh`.
 * `onOpen(ref)` opens an address, `onAnswer(gate)` opens the question a launch waits on in Attention, and `onOpenAgent(id)` the Agents page with that entry's details shown.
 */
export function createAgentsMenu({ button, popover, onOpen, onAnswer, onOpenAgent, fetchAgents = defaultFetch }) {
  const content = document.createElement("div");
  content.className = "agents-menu-body";
  popover.append(content);
  let agents = [];
  let counts = {};
  let fetchedAt = Date.now();
  let rendered = "";

  function paintButton() {
    for (const [name, value] of [["working", counts.working], ["failed", counts.failed], ["waiting", counts.waiting], ["expired", counts.expired], ["needs", counts.needsYou]]) {
      const text = String(Number(value) || 0);
      if (button.getAttribute(name) !== text) button.setAttribute(name, text);
    }
  }

  function paintMenu() {
    const now = Date.now();
    const needs = agents.filter((entry) => entry.group === "needs-you");
    const key = JSON.stringify([needs.map((entry) => [entry.id, entry.name, entry.state, entry.action, entry.harness, entry.model, entry.activity, entry.slice?.title, entry.reason, entry.launch?.endedAt, entry.launch?.waitingGate]), COUNT_LINKS.map(([, count]) => counts[count] ?? 0)]);
    if (key === rendered) return paintTimes(now);
    rendered = key;
    const group = needs.length
      ? `<p class="agents-menu-group">Needs you <prism-badge tone="neutral" size="sm">${needs.length}</prism-badge></p><div class="prism-rows agents-menu-rows" role="list" aria-label="Needs you">${needs.map((entry) => rowHtml(entry, now)).join("")}</div>`
      : "";
    const links = COUNT_LINKS.map(([words, count, icon, ref]) => `<prism-count-link icon="${icon}" count="${Number(counts[count]) || 0}" href="./review?artifact=${encodeURIComponent(ref)}" data-agents-ref="${ref}">${escapeHtml(words)}</prism-count-link>`).join("");
    content.innerHTML = `${group}<div class="prism-count-links agents-menu-counts">${links}</div><div class="agents-menu-foot"><prism-button size="sm" data-agents-ref="agents" text="Open Agents"></prism-button></div>`;
    paintTimes(now);
  }

  // A running or waiting session's time counts on between reads, and a failed one's time since it ended, in place, so a focused action keeps its focus.
  function paintTimes(now = Date.now()) {
    for (const row of content.querySelectorAll("[data-menu-agent]")) {
      const entry = agents.find((item) => item.id === row.dataset.menuAgent);
      if (!entry) continue;
      const time = row.querySelector("[data-menu-time]");
      const text = runningText((entry.launch?.runningMs ?? 0) + (ticking(entry) ? now - fetchedAt : 0));
      if (time && time.textContent !== text) time.textContent = text;
      const description = row.querySelector("[data-menu-description]");
      const words = rowDescription(entry, now);
      if (description && description.textContent !== words) description.textContent = words;
    }
  }

  function show(body) {
    agents = Array.isArray(body?.agents) ? body.agents : [];
    counts = body?.counts ?? {};
    fetchedAt = Date.now();
    paintButton();
    paintMenu();
  }

  const poller = createPoller({
    interval: REFRESH_MS,
    run: async () => {
      try {
        show(await fetchAgents());
      } catch {
        // A failed read keeps what the button and the menu showed.
      }
    }
  });

  content.addEventListener("click", (event) => {
    const target = event.target.closest?.("[data-agents-ref], [data-menu-action]");
    if (!target || !content.contains(target)) return;
    event.preventDefault();
    popover.close?.();
    if (target.dataset.agentsRef) return onOpen(target.dataset.agentsRef);
    const entry = agents.find((item) => item.id === target.closest("[data-menu-agent]")?.dataset.menuAgent);
    if (!entry) return;
    if (target.dataset.menuAction === "answer") return onAnswer(entry.launch?.waitingGate ?? null);
    return onOpenAgent(entry.id);
  });
  popover.addEventListener("prism-open", () => void poller.now());
  const clock = setInterval(() => {
    if (popover.isOpen) paintTimes();
  }, 1000);

  paintButton();
  paintMenu();
  void poller.start();
  return { refresh: () => poller.now(), stop: () => { poller.stop(); clearInterval(clock); } };
}

async function defaultFetch() {
  const response = await fetch("./api/agents", { cache: "no-store" });
  if (!response.ok) throw new Error(`api/agents answered ${response.status}`);
  return response.json();
}
