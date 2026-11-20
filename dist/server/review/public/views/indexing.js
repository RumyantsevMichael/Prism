// Generated from src/server/review/public/views/indexing.ts by scripts/native-build/compile.mjs.
import { escapeHtml } from "./util.js";
import { createActionList } from "./actions.js";
import { createPoller } from "./poller.js";
const STEPS = [
  { label: "Check runtime and model", phases: ["assets-check", "runtime-download", "runtime-extract", "model-download"] },
  { label: "Copy source files", phases: ["waiting", "snapshot-copy"] },
  { label: "Parse code", phases: ["graph:scanning", "graph:parsing", "graph:resolving", "graph:linking"] },
  { label: "Embed new fragments", phases: ["embedding"] },
  { label: "Save the index", phases: ["saving"] }
];
const ACTIVE_POLL_MS = 2e3;
const IDLE_POLL_MS = 1e4;
function stepIndex(phase) {
  const index = STEPS.findIndex((step) => step.phases.includes(phase) || phase?.startsWith("graph:") && step.phases[0].startsWith("graph:"));
  return index < 0 ? 0 : index;
}
function percent(progress) {
  if (!progress || !(progress.total > 0) || !Number.isFinite(progress.current)) return null;
  return Math.max(0, Math.min(100, Math.floor(progress.current / progress.total * 100)));
}
function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function count(progress, noun) {
  return progress.total > 0 ? `${progress.current ?? 0} of ${progress.total} ${noun}` : "";
}
function phaseDetail(progress) {
  const phase = progress?.phase;
  if (phase === "assets-check") return "Checking the runtime and model";
  if (phase === "runtime-download") return `Downloading the runtime${progress.total > 0 ? `, ${megabytes(progress.current ?? 0)} of ${megabytes(progress.total)}` : ""}`;
  if (phase === "runtime-extract") return "Unpacking the runtime";
  if (phase === "model-download") return `Downloading model file ${progress.item ?? "?"} of ${progress.items ?? "?"}${progress.file ? ` (${progress.file})` : ""}`;
  if (phase === "waiting") return "Waiting for another session's build of this project";
  if (phase === "snapshot-copy") return `Copying ${count(progress, "files")}`;
  if (phase === "graph:scanning") return "Scanning files";
  if (phase === "graph:parsing") return `Parsing ${count(progress, "files")}`;
  if (phase === "graph:resolving") return `Resolving ${count(progress, "references")}`;
  if (phase === "graph:linking") return `Linking ${count(progress, "references")}`;
  if (phase === "embedding") return progress.total > 0 ? `Embedding ${count(progress, "new fragments")}` : "Every fragment reused an earlier embedding";
  if (phase === "saving") return "Writing the index";
  return "Starting";
}
function relativeTime(value, now = Date.now()) {
  const elapsed = Math.max(0, now - Date.parse(value));
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.floor(elapsed / 6e4);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
function changedDuringBuild(status) {
  return status.state === "failed" && status.diagnostics.some((diagnostic) => diagnostic.code === "stale_snapshot");
}
function chipState(status) {
  if (!status || status.state === "unavailable") return null;
  if (status.state === "preparing") {
    const step = stepIndex(status.progress?.phase), share = percent(status.progress);
    return { tone: "busy", label: `Indexing ${step + 1}/${STEPS.length}`, detail: share === null ? STEPS[step].label : `${STEPS[step].label} ${share}%`, meter: share, component: status.progress?.component ?? "" };
  }
  if (changedDuringBuild(status)) return { tone: "warn", label: "Index rebuild pending", detail: "" };
  if (status.state === "failed") return { tone: "danger", label: "Indexing failed", detail: "" };
  if (status.state === "interrupted") return { tone: "warn", label: "Indexing stopped", detail: "" };
  if (status.state === "none") return { tone: "muted", label: "Not indexed", detail: "" };
  if (status.stale) return { tone: "warn", label: "Index out of date", detail: "" };
  return { tone: "ok", label: "Indexed", detail: relativeTime(status.index?.builtAt) };
}
function stepsHtml(progress) {
  const current = stepIndex(progress?.phase), share = percent(progress);
  return `<prism-stepper class="indexing-steps" orientation="vertical" label="Build steps">${STEPS.map((step, index) => {
    const state = index < current ? "done" : index === current ? "current" : "upcoming";
    const detail = index === current ? `<prism-meter slot="detail" label="${escapeHtml(step.label)}"${share === null ? "" : ` value="${share}"`}></prism-meter>
        <span slot="detail">${escapeHtml(phaseDetail(progress))}${share === null ? "" : ` \xB7 ${share}%`}</span>` : "";
    return `<prism-step state="${state}">${escapeHtml(step.label)}${detail}</prism-step>`;
  }).join("")}</prism-stepper>`;
}
function indexHtml(status) {
  const index = status.index;
  if (!index) return "";
  const coverage = index.coverage ?? {};
  const facts = [
    index.component ? ["Latest index", index.component] : null,
    ["Built", `${relativeTime(index.builtAt)} (${new Date(index.builtAt).toLocaleString()})`],
    Number.isFinite(coverage.files) ? ["Files", String(coverage.files)] : null,
    Number.isFinite(coverage.fragments) ? ["Fragments", String(coverage.fragments)] : null,
    coverage.complete === false ? ["Coverage", "Partial: some files were skipped or not fully parsed"] : null,
    index.diagnostics ? ["Diagnostics", String(index.diagnostics)] : null
  ].filter(Boolean);
  return `<dl class="indexing-facts">${facts.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
}
const COMPONENT_STATES = { preparing: "Building", failed: "Failed", interrupted: "Stopped", ready: "Indexed", none: "Not indexed" };
function componentState(status, identity) {
  if (!status) return null;
  if (!Array.isArray(status.components)) return status.state ?? null;
  return status.components.find((entry) => entry.component === identity)?.state ?? "none";
}
function componentsHtml(status) {
  if (!status.components?.length) return "";
  return `<p class="indexing-panel-title">Components</p><ul class="indexing-components">${status.components.map(({ component, state }) => `<li class="indexing-component-row" data-state="${escapeHtml(state)}"><span class="indexing-dot" aria-hidden="true"></span><span class="indexing-component-name">${escapeHtml(component)}</span><span class="indexing-component-state">${escapeHtml(COMPONENT_STATES[state] ?? state)}</span></li>`).join("")}</ul>`;
}
const componentPrefix = (item) => item.component ? `<span class="indexing-diagnostic-component">${escapeHtml(item.component)}</span> ` : "";
function rebuildWhen(status) {
  return status.autoRebuild ? "This page rebuilds it once the files stay unchanged for a minute." : `The next agent search or ${status.components ? "a component's Rebuild" : "Rebuild index"} updates it.`;
}
function summaryHtml(status) {
  if (status.state === "preparing") {
    const component = status.progress?.component;
    const building = component ? `<p class="indexing-building">Building <code>${escapeHtml(component)}</code></p>` : "";
    return `${building}<p>Started ${escapeHtml(relativeTime(status.startedAt))}.${status.index ? ` Searches use the previous index${component ? " of each component" : ""} until this build finishes.` : ""}</p>${stepsHtml(status.progress)}`;
  }
  if (changedDuringBuild(status)) return `<p>Files changed while the index was being built. ${rebuildWhen(status)}</p>`;
  if (status.state === "failed") {
    const retry = status.components ? "A failed component's Rebuild retries it, and an agent search that reads one tries again unless it reached a native limit." : "The next agent search tries again.";
    return `<p>The last build${status.components ? " of a component" : ""} failed ${escapeHtml(relativeTime(status.endedAt))}. ${retry}</p>
      <ul class="indexing-diagnostics">${status.diagnostics.map((item) => `<li>${componentPrefix(item)}<code>${escapeHtml(item.code)}</code> ${escapeHtml(item.message)}${item.recovery ? `<br><span>${escapeHtml(item.recovery)}</span>` : ""}</li>`).join("")}</ul>`;
  }
  if (status.state === "interrupted") return `<p>A build stopped ${escapeHtml(relativeTime(status.endedAt))} before it finished, usually because its agent session ended. The next agent search starts it again.</p>`;
  if (status.state === "none") return "<p>This project has no index yet. Prism builds it the first time an agent searches the repository.</p>";
  if (status.stale) return `<p>Files or commits changed since ${status.components ? "a component's index" : "the index"} was built. ${rebuildWhen(status)}</p>`;
  if (status.stale === null) return "<p>The index is ready. This page cannot tell whether files changed since the build, because the folder is not a Git working tree or the index predates change tracking.</p>";
  return "<p>The index matches the current files.</p>";
}
function panelHtml(status, { components = true } = {}) {
  return `${summaryHtml(status)}${indexHtml(status)}${components ? componentsHtml(status) : ""}
    <p class="indexing-panel-note">Agents also build and update the index when they search.${status.autoRebuild ? "" : " Background indexing is off for this project, so this page rebuilds it only when you ask."}</p>`;
}
const STATE_TONES = { ready: "success", preparing: "info", failed: "danger", interrupted: "warning", none: "neutral" };
let latest = null;
function currentIndexStatus() {
  return latest;
}
function createIndexingStatus({ root, button, label, detail, meter, panel, fetchJson, actionApi = null, component = root.querySelector(".indexing-component") }) {
  let status = null;
  let rendered = "";
  const summary = document.createElement("div");
  summary.className = "indexing-details";
  const actionsRoot = document.createElement("div");
  actionsRoot.className = "index-actions";
  panel.append(summary, actionsRoot);
  let controls = null;
  const heading = (action) => {
    const identity = action.target.slice("index:".length);
    const state = componentState(status, identity);
    return { label: `<code class="indexing-component-name">${escapeHtml(identity)}</code>`, detail: state ? `<prism-badge variant="status" tone="${STATE_TONES[state] ?? "neutral"}">${escapeHtml(COMPONENT_STATES[state] ?? state)}</prism-badge>` : "" };
  };
  async function refreshControls() {
    if (!actionApi || !panel.isOpen) return;
    let targets;
    try {
      targets = (await fetchJson("./api/actions/targets?kind=index")).targets;
    } catch {
      return;
    }
    controls ??= createActionList({
      root: actionsRoot,
      targets,
      api: { ...actionApi, toast: () => {
      } },
      heading,
      submitLabel: () => "Rebuild",
      compact: true,
      onRender: () => {
      },
      emptyText: "This checkout has no index to rebuild."
    });
    await controls.setTargets(targets);
  }
  function render() {
    const chip = chipState(status);
    root.hidden = !chip;
    if (!chip) {
      panel.close?.();
      return;
    }
    root.dataset.tone = chip.tone;
    label.textContent = chip.label;
    detail.textContent = chip.detail;
    detail.hidden = !chip.detail;
    if (component) {
      component.textContent = chip.component ?? "";
      component.hidden = !chip.component;
    }
    meter.hidden = chip.tone !== "busy";
    if (chip.meter === null || chip.meter === void 0) meter.removeAttribute("value");
    else meter.setAttribute("value", String(chip.meter));
    button.setAttribute("tip", [chip.label, [chip.component, chip.detail].filter(Boolean).join(" \xB7 ")].filter(Boolean).join(": "));
    const html = panelHtml(status, { components: !actionApi });
    if (html !== rendered) {
      rendered = html;
      summary.innerHTML = html;
    }
    controls?.render();
  }
  async function load() {
    try {
      status = await fetchJson("./api/indexing");
    } catch {
    }
    latest = status;
    render();
    void refreshControls();
    document.dispatchEvent(new CustomEvent("prism:indexing", { detail: status }));
  }
  const poller = createPoller({ run: load, interval: () => status?.state === "preparing" ? ACTIVE_POLL_MS : IDLE_POLL_MS });
  const refresh = () => poller.now();
  panel.addEventListener("prism-open", () => void refreshControls());
  document.addEventListener("prism:action", (event) => {
    if (event.detail?.action === "index.rebuild") void refresh();
  });
  void poller.start();
  return { refresh };
}
export {
  chipState,
  componentState,
  createIndexingStatus,
  currentIndexStatus,
  panelHtml,
  relativeTime
};
