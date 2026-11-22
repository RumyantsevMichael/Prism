// Generated from src/server/review/public/views/coding-agents.ts by scripts/native-build/compile.mjs.
import { badge, escapeHtml } from "./util.js";
import { readOnlyNotice } from "./actions.js";
const INSTALL_DEADLINE_MS = 6e5;
const SOURCE_URL = /^https?:\/\/[^\s]+$/i;
function sourceHtml(source) {
  if (typeof source !== "string" || !source) return "";
  const shown = source.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return SOURCE_URL.test(source) ? `<a href="${escapeHtml(source)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shown)}</a>` : escapeHtml(shown);
}
function factsHtml(agent) {
  const authors = Array.isArray(agent.authors) ? agent.authors.filter((item) => typeof item === "string" && item).join(", ") : "";
  const license = typeof agent.license === "string" ? agent.license : "";
  return [escapeHtml(authors), escapeHtml(license), sourceHtml(agent.source)].filter(Boolean).join(" \xB7 ");
}
const keyOf = (agent, index) => agent.id ?? `entry-${index}`;
function agentOffer(agent) {
  const actions = [];
  const reasons = [];
  if (agent.origin === "registry" && agent.id) {
    if (!agent.installed) {
      if (agent.install?.available) actions.push({ id: "agents.install", label: "Install", primary: true });
      else if (agent.install?.reason) reasons.push(agent.install.reason);
    } else {
      if (agent.update) actions.push({ id: "agents.update", label: "Update", primary: true });
      actions.push({ id: "agents.remove", label: "Remove", primary: false });
    }
  }
  if ((agent.installed || agent.origin === "declared") && agent.launch && !agent.launch.available && agent.launch.reason) reasons.push(agent.launch.reason);
  return { actions, reasons };
}
function rowHtml(agent, index, { writable, busy, errors }) {
  const key = keyOf(agent, index);
  const { actions, reasons } = agentOffer(agent);
  const mark = (text, tone) => badge(text, tone).replace("<prism-badge ", '<prism-badge slot="kind" ');
  const marks = [
    agent.installed ? mark("Installed", "success") : "",
    agent.origin === "declared" ? mark("Declared", "neutral") : "",
    agent.update?.version ? mark(`Update ${agent.update.version}`, "accent") : ""
  ].join("");
  const version = agent.installed?.version ?? agent.version;
  const working = busy.get(key);
  const notes = [
    agent.description ? `<span>${escapeHtml(agent.description)}</span>` : "",
    ...reasons.map((reason) => `<span class="coding-agent-reason">${escapeHtml(reason)}</span>`),
    working ? `<span class="coding-agent-reason" aria-live="polite">${escapeHtml(working)}</span>` : "",
    errors.get(key) ? `<span class="coding-agent-error" role="alert">${escapeHtml(errors.get(key))}</span>` : ""
  ].join("");
  const buttons = actions.map((action) => `<prism-button slot="action" size="sm"${action.primary ? ' variant="primary"' : ""} text="${escapeHtml(action.label)}" data-agent-action="${escapeHtml(action.id)}"${!writable || working ? " disabled" : ""}></prism-button>`).join("");
  const facts = factsHtml(agent);
  const usable = agent.installed || agent.origin === "declared" ? agent.launch?.available : agent.install?.available;
  return `<prism-row icon="agent" tone="${usable ? "accent" : "neutral"}" wrap stack data-agent="${escapeHtml(key)}">${escapeHtml(agent.name ?? agent.id ?? "")}${version ? ` <span class="coding-agent-version">${escapeHtml(version)}</span>` : ""}
    ${facts ? `<span slot="description">${facts}</span>` : ""}
    ${notes ? `<span slot="detail">${notes}</span>` : ""}
    ${marks}${buttons}
  </prism-row>`;
}
function registryHtml(registry) {
  if (registry?.state !== "ready") {
    const reason = registry?.reason ?? "Prism cannot read the agent registry.";
    return `<prism-banner class="coding-agents-note" tone="warning"><p>${escapeHtml(reason)} Installed and declared agents stay usable; installs and updates wait until it answers.</p></prism-banner>`;
  }
  const read = registry.readAt ? `, read <prism-time datetime="${escapeHtml(registry.readAt)}"></prism-time>` : "";
  return `<p class="settings-hint coding-agents-note">From the ACP registry${read}. Each install and update asks you to confirm outside the browser and runs no install script.</p>`;
}
function createCodingAgents({ root, read, api, canWrite, shown = null }) {
  let listing = null;
  let failure = null;
  let drawn = "";
  const busy = /* @__PURE__ */ new Map();
  const errors = /* @__PURE__ */ new Map();
  const agents = () => Array.isArray(listing?.agents) ? listing.agents : [];
  function html() {
    if (!listing) return `<p class="action-error" role="alert">${escapeHtml(failure ?? "")}</p>`;
    const writable = Boolean(canWrite());
    const list = agents();
    const rows = list.length ? `<div class="prism-rows coding-agents-list" role="list">${list.map((agent, index) => rowHtml(agent, index, { writable, busy, errors })).join("")}</div>` : `<prism-empty-state heading="No coding agents yet"><p>Agents from the ACP registry show here to install, and agents declared in acp-agents.json show here once declared.</p></prism-empty-state>`;
    return `${failure ? `<p class="action-error" role="alert">${escapeHtml(failure)}</p>` : ""}${writable || !list.length ? "" : readOnlyNotice()}${rows}${registryHtml(listing.registry)}`;
  }
  function render() {
    const next = html();
    if (next !== drawn) {
      const focused = root.contains(document.activeElement) ? document.activeElement?.closest?.("[data-agent-action]") : null;
      const focusKey = focused ? `${focused.closest("[data-agent]")?.dataset.agent}|${focused.dataset.agentAction}` : null;
      drawn = next;
      root.innerHTML = next;
      if (focusKey) {
        const [agent, action] = focusKey.split("|");
        const back = root.querySelector(`[data-agent="${CSS.escape(agent)}"] [data-agent-action="${CSS.escape(action)}"]:not([disabled])`);
        (back?.control ?? back)?.focus?.({ preventScroll: true });
      }
    }
    shown?.();
  }
  let reading = null;
  function refresh() {
    reading ??= (async () => {
      try {
        const response = await read();
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message ?? "The coding agents could not be read.");
        listing = body;
        failure = null;
      } catch (error) {
        failure = error?.message || "The coding agents could not be read.";
      } finally {
        reading = null;
      }
      render();
    })();
    return reading;
  }
  async function run(agent, key, id) {
    const name = agent.name ?? agent.id;
    if (id === "agents.remove") {
      const accepted = await api.confirm({ title: `Remove ${name}?`, message: `Prism removes every installed version of ${name} from this computer, and it is offered as a host no longer. A session that runs on it keeps it until that session ends.` });
      if (!accepted) return;
    }
    errors.delete(key);
    busy.set(key, id === "agents.remove" ? `Removing ${name}\u2026` : "Confirm or refuse in the dialog on this computer.");
    render();
    const answer = await api.apply({ action: id, target: `agent:${agent.id}`, input: {}, revision: null }, { deadlineMs: INSTALL_DEADLINE_MS });
    busy.delete(key);
    const result = answer?.json ?? {};
    if (answer?.status === 200) {
      const after = result.applied?.after ?? result.after ?? null;
      const version = after?.version ? ` ${after.version}` : "";
      api.toast(id === "agents.remove" ? `${name} was removed.` : `${name}${version} is installed.`);
    } else {
      errors.set(key, result.reason ?? result.message ?? "The change was not applied.");
    }
    await refresh();
  }
  root.addEventListener("click", (event) => {
    const button = event.target.closest?.("prism-button[data-agent-action]");
    if (!button || button.hasAttribute("disabled") || !root.contains(button)) return;
    const key = button.closest("[data-agent]")?.dataset.agent;
    const agent = agents().find((item, index) => keyOf(item, index) === key);
    if (!agent || busy.has(key)) return;
    void run(agent, key, button.dataset.agentAction);
  });
  return {
    refresh,
    /** Whether the list has been read once, so the section has something to show. */
    ready: () => listing !== null || failure !== null
  };
}
export {
  agentOffer,
  createCodingAgents
};
