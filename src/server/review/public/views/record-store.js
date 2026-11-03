import { relativeTime } from "./indexing.js";
import { diffHtml } from "./line-diff.js";
import { escapeHtml, formatTime, keyValues, plural } from "./util.js";

const PROBLEMS = { no_upstream: "Records not shared", not_a_repository: "Records not synced", push_rejected: "Records not pushed", merge_failed: "Records not merged", fetch_failed: "Records not fetched", git_failed: "Records not synced", conflicts: "Record conflicts saved" };
const STATES = { ok: "Synced", ...PROBLEMS };

/** Where the records live, as the status bar names it: { label, title, tone }. */
export function storeItem(store) {
  if (!store) return null;
  if (store.kind === "project") return { label: "Records in project", title: `Records live in this checkout's ${store.label} folder.`, tone: "muted" };
  const noun = store.kind === "remote" ? "Remote store" : "Store";
  if (store.unavailable) return { label: `${noun} unavailable`, title: store.unavailable, tone: "danger" };
  return { label: `${noun} ${store.label}`, title: [`Records live in the ${store.kind === "remote" ? "store named by its remote" : "store folder"} ${store.label}.`, store.location ? `Folder: ${store.location}` : ""].filter(Boolean).join("\n"), tone: "muted" };
}

/** The store's sync state, as the status bar names it, or null when nothing syncs: { label, tone, problem }. */
export function syncItem(store, status, now = Date.now()) {
  if (!store || store.kind === "project" || store.unavailable) return null;
  if (!store.sync) return { label: "Sync off", tone: "muted", problem: false };
  if (!status) return { label: "Not synced yet", tone: "muted", problem: false };
  const when = relativeTime(status.at, now);
  const problem = Object.hasOwn(PROBLEMS, status.state);
  return { label: `${STATES[status.state] ?? status.state}${when ? `${problem ? " · " : " "}${when}` : ""}`, tone: problem ? (status.state === "conflicts" ? "warn" : "danger") : "ok", problem };
}

function storeFacts(store, status) {
  const where = store.kind === "project" ? `In this checkout, <code>${escapeHtml(store.label)}</code>` : `${store.kind === "remote" ? "Remote store" : "Store folder"} <code>${escapeHtml(store.label)}</code>`;
  return keyValues([
    ["Records", where],
    ["Folder", store.location && store.kind !== "project" ? `<code>${escapeHtml(store.location)}</code>` : null],
    ["Sync", store.kind === "project" ? null : store.sync ? "on" : "off"],
    ["Last sync", status ? `${escapeHtml(STATES[status.state] ?? status.state)} · ${escapeHtml(relativeTime(status.at))} <span class="muted">(${escapeHtml(formatTime(status.at))})</span>` : null],
    ["Ahead", status?.ahead ? plural(status.ahead, "local commit") : null],
    ["Behind", status?.behind ? plural(status.behind, "upstream commit") : null]
  ]);
}

function conflictsHtml(conflicts, status) {
  if (!conflicts.length) return '<p class="muted">No saved conflicts in this store.</p>';
  const latest = new Set((status?.conflicts ?? []).map((item) => item.savedAs).filter(Boolean));
  return `<ul class="conflict-list">${conflicts.map((item) => `
    <li><details class="conflict" data-saved-as="${escapeHtml(item.savedAs)}">
      <summary><code>.prism/${escapeHtml(item.path)}</code><span class="muted">saved ${escapeHtml(relativeTime(item.at))}</span>${latest.has(item.savedAs) ? '<span class="status-pill is-warn">latest sync</span>' : ""}</summary>
      <div class="conflict-body"><p class="muted">Loading the saved copy…</p></div>
    </details></li>`).join("")}</ul>`;
}

// A record the local side deleted while the upstream changed it has no saved copy, so the latest status names it alone.
function unsavedHtml(status) {
  const unsaved = (status?.conflicts ?? []).filter((item) => !item.savedAs);
  return unsaved.length ? `<p class="muted">Deleted locally while the upstream changed ${unsaved.map((item) => `<code>.prism/${escapeHtml(item.path)}</code>`).join(", ")}; the upstream version was kept and nothing was saved.</p>` : "";
}

export function createRecordStoreStatus({ storeButton, storeLabel, syncButton, syncLabel, dialog, fetchJson, openRecord, hasArtifact }) {
  let store = null;
  let status = null;

  function update(nextStore, nextStatus) {
    store = nextStore ?? null;
    status = nextStatus ?? null;
    const where = storeItem(store);
    storeButton.hidden = !where;
    if (where) {
      storeLabel.textContent = where.label;
      storeButton.title = where.title;
      storeButton.dataset.tone = where.tone;
    }
    const sync = syncItem(store, status);
    syncButton.hidden = !sync;
    if (sync) {
      syncLabel.textContent = sync.label;
      syncButton.dataset.tone = sync.tone;
      syncButton.title = [status?.message, sync.problem ? "Click for details" : ""].filter(Boolean).join("\n") || sync.label;
    }
  }

  async function open() {
    if (!store) return;
    const problem = syncItem(store, status)?.problem;
    dialog.innerHTML = `<header class="store-dialog-header"><h2 id="store-dialog-title">Record store</h2><button type="button" class="tool-button" data-close>Close</button></header>
      <div class="store-dialog-body">
        ${store.unavailable ? `<p class="store-message is-danger">${escapeHtml(store.unavailable)}</p>` : ""}
        ${problem && status.message ? `<p class="store-message ${status.state === "conflicts" ? "is-warn" : "is-danger"}">${escapeHtml(status.message)}</p>` : ""}
        ${storeFacts(store, status)}
        ${store.kind === "project" ? "" : `<section class="store-conflicts"><h3>Saved conflicts</h3>
          <p class="muted">When two checkouts change the same record, the sync keeps the upstream version and saves the local one. Compare them to redo a lost change through an agent.</p>
          ${unsavedHtml(status)}<div data-conflicts><p class="muted">Loading…</p></div></section>`}
      </div>`;
    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
    if (!dialog.open) dialog.showModal();
    const holder = dialog.querySelector("[data-conflicts]");
    if (!holder) return;
    let conflicts = [];
    try { conflicts = (await fetchJson("./api/store/conflicts")).conflicts; } catch { holder.innerHTML = '<p class="error">The saved conflicts could not be listed.</p>'; return; }
    holder.innerHTML = conflictsHtml(conflicts, status);
    for (const details of holder.querySelectorAll("details.conflict")) details.addEventListener("toggle", () => details.open && loadConflict(details), { once: false });
    holder.querySelector("details.conflict")?.setAttribute("open", "");
  }

  async function loadConflict(details) {
    if (details.dataset.loaded) return;
    details.dataset.loaded = "true";
    const body = details.querySelector(".conflict-body");
    try {
      const conflict = await fetchJson(`./api/store/conflict?savedAs=${encodeURIComponent(details.dataset.savedAs)}`);
      const record = `.prism/${conflict.path}`;
      body.innerHTML = `${conflict.current === null ? '<p class="muted">The record no longer exists, so every saved line shows as added.</p>' : ""}
        ${diffHtml(conflict.current, conflict.saved, { beforeLabel: "current record", afterLabel: "saved local copy" })}
        ${conflict.current !== null && hasArtifact(record) ? `<p><button type="button" class="link-chip artifact-chip" data-record="${escapeHtml(record)}"><code>Open the current record</code></button></p>` : ""}`;
      body.querySelector("[data-record]")?.addEventListener("click", () => { dialog.close(); openRecord(record); });
    } catch {
      body.innerHTML = '<p class="error">The saved copy could not be read.</p>';
    }
  }

  storeButton.addEventListener("click", open);
  syncButton.addEventListener("click", open);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  return { update };
}
