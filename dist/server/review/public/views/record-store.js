import { relativeTime } from "./indexing.js";
import { diffHtml } from "./line-diff.js";
import { escapeHtml, formatTime, keyValues, plural } from "./util.js";

const PROBLEMS = { no_upstream: "Records not shared", not_a_repository: "Records not synced", push_rejected: "Records not pushed", merge_failed: "Records not merged", fetch_failed: "Records not fetched", git_failed: "Records not synced", conflicts: "Record conflicts saved" };
const STATES = { ok: "Synced", ...PROBLEMS };

// A store's short name: the last part of its folder or remote, without a .git ending.
function storeName(label) {
  const parts = String(label ?? "").replace(/[\\/]+$/, "").split(/[\\/:]/).filter(Boolean);
  return (parts.at(-1) ?? String(label ?? "")).replace(/\.git$/, "");
}

/** Where the records live: { label, short, title, tone }, where the status bar shows short and its tip title. */
export function storeItem(store) {
  if (!store) return null;
  if (store.kind === "project") return { label: "Records in project", short: "Records in project", title: `Records live in this checkout's ${store.label} folder.`, tone: "muted" };
  const noun = store.kind === "remote" ? "Remote store" : "Store";
  if (store.unavailable) return { label: `${noun} unavailable`, short: "Shared store unavailable", title: store.unavailable, tone: "danger" };
  // The status bar names the shared store at a glance, by the workspace name when it has one; its tip and the details say where it lives.
  return { label: `${noun} ${store.label}`, short: `Shared store ${store.workspaceName ?? storeName(store.label)}`, title: [`Records live in the ${store.kind === "remote" ? "store named by its remote" : "store folder"} ${store.label}.`, store.location ? `Folder: ${store.location}` : ""].filter(Boolean).join("\n"), tone: "muted" };
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

// A saved conflict names its record by title and kind, such as Coordination state · Harden request retries.
function recordName(path, describe) {
  const named = describe(`.prism/${path}`);
  return named.label === named.kind ? named.kind : `${named.kind} · ${named.label}`;
}

function conflictsHtml(conflicts, status, describe) {
  if (!conflicts.length) return '<p class="muted">No saved conflicts in this store.</p>';
  const latest = new Set((status?.conflicts ?? []).map((item) => item.savedAs).filter(Boolean));
  return `<ul class="conflict-list">${conflicts.map((item) => `
    <li><prism-disclosure class="conflict" data-saved-as="${escapeHtml(item.savedAs)}" summary="${escapeHtml(`${recordName(item.path, describe)} · saved ${relativeTime(item.at)}${latest.has(item.savedAs) ? " · latest sync" : ""}`)}">
      <div class="conflict-body"><p class="muted">Loading the saved copy…</p></div>
    </prism-disclosure></li>`).join("")}</ul>`;
}

// A record the local side deleted while the upstream changed it has no saved copy, so the latest status names it alone.
function unsavedHtml(status, describe) {
  const unsaved = (status?.conflicts ?? []).filter((item) => !item.savedAs);
  return unsaved.length ? `<p class="muted">Deleted locally while the upstream changed ${unsaved.map((item) => escapeHtml(recordName(item.path, describe))).join(", ")}; the upstream version was kept and nothing was saved.</p>` : "";
}

export function createRecordStoreStatus({ storeButton, storeLabel, syncButton, syncLabel, dialog, fetchJson, openRecord, hasArtifact, describe = (path) => ({ label: path, kind: "Record" }) }) {
  let store = null;
  let status = null;
  // The dialog keeps its own header and Close button, so the details render into one holder in its body.
  const content = document.createElement("div");
  content.className = "store-details";
  dialog.append(content);

  function update(nextStore, nextStatus) {
    store = nextStore ?? null;
    status = nextStatus ?? null;
    const where = storeItem(store);
    storeButton.hidden = !where;
    if (where) {
      storeLabel.textContent = where.short;
      storeButton.setAttribute("tip", where.title);
      storeButton.dataset.tone = where.tone;
    }
    const sync = syncItem(store, status);
    syncButton.hidden = !sync;
    if (sync) {
      syncLabel.textContent = sync.label;
      syncButton.dataset.tone = sync.tone;
      syncButton.setAttribute("tip", [status?.message, sync.problem ? "Click for details" : ""].filter(Boolean).join("\n") || sync.label);
    }
  }

  async function open() {
    if (!store) return;
    const problem = syncItem(store, status)?.problem;
    content.innerHTML = `<div class="store-details-body">
        ${store.unavailable ? `<p class="store-message is-danger">${escapeHtml(store.unavailable)}</p>` : ""}
        ${problem && status.message ? `<p class="store-message ${status.state === "conflicts" ? "is-warn" : "is-danger"}">${escapeHtml(status.message)}</p>` : ""}
        ${storeFacts(store, status)}
        ${store.kind === "project" ? "" : `<section class="store-conflicts"><h3>Saved conflicts</h3>
          <p class="muted">When two checkouts change the same record, the sync keeps the upstream version and saves the local one. Compare them to redo a lost change through an agent.</p>
          ${unsavedHtml(status, describe)}<div data-conflicts><p class="muted">Loading…</p></div></section>`}
      </div>`;
    if (!dialog.isOpen) dialog.show();
    const holder = content.querySelector("[data-conflicts]");
    if (!holder) return;
    let conflicts = [];
    try { conflicts = (await fetchJson("./api/store/conflicts")).conflicts; } catch { holder.innerHTML = '<p class="error">The saved conflicts could not be listed.</p>'; return; }
    holder.innerHTML = conflictsHtml(conflicts, status, describe);
    for (const details of holder.querySelectorAll("prism-disclosure.conflict")) details.addEventListener("toggle", () => details.hasAttribute("open") && loadConflict(details));
    const first = holder.querySelector("prism-disclosure.conflict");
    first?.setAttribute("open", "");
    if (first) void loadConflict(first);
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
        ${conflict.current !== null && hasArtifact(record) ? `<p><prism-button size="sm" data-record="${escapeHtml(record)}">Open the current record</prism-button></p>` : ""}`;
      body.querySelector("[data-record]")?.addEventListener("click", () => { dialog.close(); openRecord(record); });
    } catch {
      body.innerHTML = '<p class="error">The saved copy could not be read.</p>';
    }
  }

  storeButton.addEventListener("click", open);
  syncButton.addEventListener("click", open);
  return { update };
}
