import { escapeHtml } from "./util.js";

// The index build reports unrelated totals per step, so the chip shows the current step and its own percentage, never an overall one.
const STEPS = [
  { label: "Check runtime and model", phases: ["assets-check", "runtime-download", "runtime-extract", "model-download"] },
  { label: "Copy source files", phases: ["waiting", "snapshot-copy"] },
  { label: "Parse code", phases: ["graph:scanning", "graph:parsing", "graph:resolving", "graph:linking"] },
  { label: "Embed new fragments", phases: ["embedding"] },
  { label: "Save the index", phases: ["saving"] }
];
const ACTIVE_POLL_MS = 2000;
const IDLE_POLL_MS = 10000;

function stepIndex(phase) {
  const index = STEPS.findIndex((step) => step.phases.includes(phase) || (phase?.startsWith("graph:") && step.phases[0].startsWith("graph:")));
  return index < 0 ? 0 : index;
}

function percent(progress) {
  if (!progress || !(progress.total > 0) || !Number.isFinite(progress.current)) return null;
  return Math.max(0, Math.min(100, Math.floor((progress.current / progress.total) * 100)));
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

export function relativeTime(value, now = Date.now()) {
  const elapsed = Math.max(0, now - Date.parse(value));
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

// A snapshot that changed during the build is ordinary editing, so it reads as a pending rebuild rather than an error.
function changedDuringBuild(status) {
  return status.state === "failed" && status.diagnostics.some((diagnostic) => diagnostic.code === "stale_snapshot");
}

export function chipState(status) {
  if (!status || status.state === "unavailable") return null;
  if (status.state === "preparing") {
    const step = stepIndex(status.progress?.phase), share = percent(status.progress);
    return { tone: "busy", label: `Indexing ${step + 1}/${STEPS.length}`, detail: share === null ? STEPS[step].label : `${STEPS[step].label} ${share}%`, meter: share };
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
  return `<ol class="indexing-steps">${STEPS.map((step, index) => {
    const state = index < current ? "done" : index === current ? "current" : "pending";
    const meter = index === current
      ? `<span class="indexing-step-meter${share === null ? " indeterminate" : ""}" role="progressbar" aria-label="${escapeHtml(step.label)}"${share === null ? "" : ` aria-valuemin="0" aria-valuemax="100" aria-valuenow="${share}"`}><span style="width:${share ?? 100}%"></span></span>
        <span class="indexing-step-detail">${escapeHtml(phaseDetail(progress))}${share === null ? "" : ` · ${share}%`}</span>`
      : "";
    return `<li class="indexing-step ${state}"><span class="indexing-step-label">${escapeHtml(step.label)}</span>${meter}</li>`;
  }).join("")}</ol>`;
}

function indexHtml(status) {
  const index = status.index;
  if (!index) return "";
  const coverage = index.coverage ?? {};
  const facts = [
    ["Built", `${relativeTime(index.builtAt)} (${new Date(index.builtAt).toLocaleString()})`],
    Number.isFinite(coverage.files) ? ["Files", String(coverage.files)] : null,
    Number.isFinite(coverage.fragments) ? ["Fragments", String(coverage.fragments)] : null,
    coverage.complete === false ? ["Coverage", "Partial: some files were skipped or not fully parsed"] : null,
    index.diagnostics ? ["Diagnostics", String(index.diagnostics)] : null
  ].filter(Boolean);
  return `<dl class="indexing-facts">${facts.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
}

function summaryHtml(status) {
  if (status.state === "preparing") return `<p>Started ${escapeHtml(relativeTime(status.startedAt))}.${status.index ? " Searches use the previous index until this build finishes." : ""}</p>${stepsHtml(status.progress)}`;
  if (changedDuringBuild(status)) return "<p>Files changed while the index was being built. The next agent search rebuilds it from the current files.</p>";
  if (status.state === "failed") {
    return `<p>The last build failed ${escapeHtml(relativeTime(status.endedAt))}. The next agent search tries again.</p>
      <ul class="indexing-diagnostics">${status.diagnostics.map((item) => `<li><code>${escapeHtml(item.code)}</code> ${escapeHtml(item.message)}${item.recovery ? `<br><span>${escapeHtml(item.recovery)}</span>` : ""}</li>`).join("")}</ul>`;
  }
  if (status.state === "interrupted") return `<p>A build stopped ${escapeHtml(relativeTime(status.endedAt))} before it finished, usually because its agent session ended. The next agent search starts it again.</p>`;
  if (status.state === "none") return "<p>This project has no index yet. Prism builds it the first time an agent searches the repository.</p>";
  if (status.stale) return "<p>Files or commits changed since the index was built. The next agent search updates it.</p>";
  if (status.stale === null) return "<p>The index is ready. This page cannot tell whether files changed since the build, because the folder is not a Git working tree or the index predates change tracking.</p>";
  return "<p>The index matches the current files.</p>";
}

export function panelHtml(status) {
  return `<p class="indexing-panel-title">Repository index</p>${summaryHtml(status)}${indexHtml(status)}
    <p class="indexing-panel-note">Agents build and update the index when they search. This page only shows its state.</p>`;
}

export function createIndexingStatus({ root, button, label, detail, meter, panel, fetchJson }) {
  let status = null;
  let timer = null;
  let rendered = "";

  function render() {
    const chip = chipState(status);
    root.hidden = !chip;
    if (!chip) {
      setOpen(false);
      return;
    }
    root.dataset.tone = chip.tone;
    label.textContent = chip.label;
    detail.textContent = chip.detail;
    detail.hidden = !chip.detail;
    meter.hidden = chip.tone !== "busy";
    meter.classList.toggle("indeterminate", chip.meter === null || chip.meter === undefined);
    meter.firstElementChild.style.width = `${chip.meter ?? 100}%`;
    button.title = [chip.label, chip.detail].filter(Boolean).join(": ");
    // The panel is rebuilt only when its content changes, so an open panel keeps its scroll position between polls.
    const html = panelHtml(status);
    if (html !== rendered) {
      rendered = html;
      panel.innerHTML = html;
    }
  }

  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  }

  async function refresh() {
    clearTimeout(timer);
    try {
      status = await fetchJson("./api/indexing");
    } catch {
    }
    render();
    timer = setTimeout(refresh, status?.state === "preparing" ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }

  button.addEventListener("click", () => setOpen(panel.hidden));
  document.addEventListener("click", (event) => {
    if (!panel.hidden && !root.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      setOpen(false);
      button.focus();
    }
  });
  void refresh();
  return { refresh };
}
