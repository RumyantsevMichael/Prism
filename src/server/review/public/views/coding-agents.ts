import { badge, escapeHtml } from "./util.js";
import { readOnlyNotice } from "./actions.js";

// The Coding agents section of Settings: every agent that GET api/coding-agents lists, as a prism-row each with its name and version,
// its authors, license, and source, its description, the marks of an installed or declared agent and of an available update, and
// Install, Update, and Remove where each applies, or the reason in its place. While the registry cannot be read a warning banner says
// why, and the installed and declared agents stay listed. Install and Update wait on the native confirmation, so their request may
// last as long as the person takes to answer it.

// How long an install or update may wait: the dialog waits on the person, and the download and its checks follow.
const INSTALL_DEADLINE_MS = 600000;

const SOURCE_URL = /^https?:\/\/[^\s]+$/i;

// A source reads as its address without the scheme, and links only when it is a web address.
function sourceHtml(source: any) {
  if (typeof source !== "string" || !source) return "";
  const shown = source.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return SOURCE_URL.test(source) ? `<a href="${escapeHtml(source)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shown)}</a>` : escapeHtml(shown);
}

function factsHtml(agent: any) {
  const authors = Array.isArray(agent.authors) ? agent.authors.filter((item: any) => typeof item === "string" && item).join(", ") : "";
  const license = typeof agent.license === "string" ? agent.license : "";
  return [escapeHtml(authors), escapeHtml(license), sourceHtml(agent.source)].filter(Boolean).join(" · ");
}

const keyOf = (agent: any, index: number) => agent.id ?? `entry-${index}`;

/** What one agent's row offers: { actions: [{ id, label, primary }], reasons }, from its marks and availability. */
export function agentOffer(agent: any) {
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
  // An agent Prism can launch says nothing more; one it cannot launch says why, once it is installed or declared.
  if ((agent.installed || agent.origin === "declared") && agent.launch && !agent.launch.available && agent.launch.reason) reasons.push(agent.launch.reason);
  return { actions, reasons };
}

function rowHtml(agent: any, index: number, { writable, busy, errors }: { writable: boolean; busy: Map<string, string>; errors: Map<string, string> }) {
  const key = keyOf(agent, index);
  const { actions, reasons } = agentOffer(agent);
  const mark = (text: string, tone: string) => badge(text, tone).replace("<prism-badge ", '<prism-badge slot="kind" ');
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
    errors.get(key) ? `<span class="coding-agent-error" role="alert">${escapeHtml(errors.get(key)!)}</span>` : ""
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

function registryHtml(registry: any) {
  if (registry?.state !== "ready") {
    const reason = registry?.reason ?? "Prism cannot read the agent registry.";
    return `<prism-banner class="coding-agents-note" tone="warning"><p>${escapeHtml(reason)} Installed and declared agents stay usable; installs and updates wait until it answers.</p></prism-banner>`;
  }
  const read = registry.readAt ? `, read <prism-time datetime="${escapeHtml(registry.readAt)}"></prism-time>` : "";
  return `<p class="settings-hint coding-agents-note">From the ACP registry${read}. Each install and update asks you to confirm outside the browser and runs no install script.</p>`;
}

/**
 * Draws the Coding agents section into root. read() resolves to the response of GET api/coding-agents; api is the page's action API,
 * { apply(request, { deadlineMs }), confirm({ title, message }), toast(message) }; canWrite() says whether this tab may apply actions.
 * shown() runs after each draw. refresh() reads the list again and draws it; it resolves once drawn.
 */
export function createCodingAgents({ root, read, api, canWrite, shown = null }: any) {
  let listing: any = null;
  let failure: string | null = null;
  let drawn = "";
  const busy = new Map<string, string>();
  const errors = new Map<string, string>();

  const agents = () => (Array.isArray(listing?.agents) ? listing.agents : []);

  function html() {
    if (!listing) return `<p class="action-error" role="alert">${escapeHtml(failure ?? "")}</p>`;
    const writable = Boolean(canWrite());
    const list = agents();
    const rows = list.length
      ? `<div class="prism-rows coding-agents-list" role="list">${list.map((agent: any, index: number) => rowHtml(agent, index, { writable, busy, errors })).join("")}</div>`
      : `<prism-empty-state heading="No coding agents yet"><p>Agents from the ACP registry show here to install, and agents declared in acp-agents.json show here once declared.</p></prism-empty-state>`;
    return `${failure ? `<p class="action-error" role="alert">${escapeHtml(failure)}</p>` : ""}${writable || !list.length ? "" : readOnlyNotice()}${rows}${registryHtml(listing.registry)}`;
  }

  function render() {
    const next = html();
    if (next !== drawn) {
      // A redraw keeps focus on the button the person used, when it is still there.
      const focused = root.contains(document.activeElement) ? (document.activeElement as any)?.closest?.("[data-agent-action]") : null;
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

  let reading: Promise<void> | null = null;
  function refresh() {
    reading ??= (async () => {
      try {
        const response = await read();
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message ?? "The coding agents could not be read.");
        listing = body;
        failure = null;
      } catch (error: any) {
        failure = error?.message || "The coding agents could not be read.";
      } finally {
        reading = null;
      }
      render();
    })();
    return reading;
  }

  async function run(agent: any, key: string, id: string) {
    const name = agent.name ?? agent.id;
    if (id === "agents.remove") {
      const accepted = await api.confirm({ title: `Remove ${name}?`, message: `Prism removes every installed version of ${name} from this computer, and it is offered as a host no longer. A session that runs on it keeps it until that session ends.` });
      if (!accepted) return;
    }
    errors.delete(key);
    busy.set(key, id === "agents.remove" ? `Removing ${name}…` : "Confirm or refuse in the dialog on this computer.");
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

  root.addEventListener("click", (event: any) => {
    const button = event.target.closest?.("prism-button[data-agent-action]");
    if (!button || button.hasAttribute("disabled") || !root.contains(button)) return;
    const key = button.closest("[data-agent]")?.dataset.agent;
    const agent = agents().find((item: any, index: number) => keyOf(item, index) === key);
    if (!agent || busy.has(key)) return;
    void run(agent, key, button.dataset.agentAction);
  });

  return {
    refresh,
    /** Whether the list has been read once, so the section has something to show. */
    ready: () => listing !== null || failure !== null
  };
}
