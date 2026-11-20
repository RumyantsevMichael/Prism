// Generated from src/server/review/public/views/record-store.ts by scripts/native-build/compile.mjs.
import { relativeTime } from "./indexing.js";
import { everyMinute } from "../kit/claim-time.js";
import { diffHtml } from "./line-diff.js";
import { escapeHtml, formatTime, keyValues, plural } from "./util.js";
const PROBLEMS = { no_upstream: "Records not shared", not_a_repository: "Records not synced", push_rejected: "Records not pushed", merge_failed: "Records not merged", fetch_failed: "Records not fetched", git_failed: "Records not synced", conflicts: "Record conflicts saved" };
const STATES = { ok: "Synced", ...PROBLEMS };
function storeName(label) {
  const parts = String(label ?? "").replace(/[\\/]+$/, "").split(/[\\/:]/).filter(Boolean);
  return (parts.at(-1) ?? String(label ?? "")).replace(/\.git$/, "");
}
function storeItem(store) {
  if (!store) return null;
  if (store.kind === "project") return { label: "Records in project", short: "Records in project", title: `Records live in this checkout's ${store.label} folder.`, tone: "muted" };
  const noun = store.kind === "remote" ? "Remote store" : "Store";
  if (store.unavailable) return { label: `${noun} unavailable`, short: "Shared store unavailable", title: store.unavailable, tone: "danger" };
  const title = [`Records live in the ${store.kind === "remote" ? "store named by its remote" : "store folder"} ${store.label}.`, store.location ? `Folder: ${store.location}` : ""].filter(Boolean).join("\n");
  const name = store.workspaceName ?? storeName(store.label);
  const waiting = store.awaitingMove?.files;
  const kept = store.keptInCheckout?.files;
  const details = [title, store.awaitingMove?.message, store.keptInCheckout?.message].filter(Boolean).join("\n");
  if (waiting) return { label: `${noun} ${store.label} \xB7 ${plural(waiting, "file")} to move`, short: `Shared store ${name} \xB7 ${plural(waiting, "file")} to move`, title: details, tone: "warn" };
  if (kept) return { label: `${noun} ${store.label} \xB7 ${plural(kept, "file")} kept in checkout`, short: `Shared store ${name} \xB7 ${plural(kept, "file")} kept in checkout`, title: details, tone: "muted" };
  return { label: `${noun} ${store.label}`, short: `Shared store ${name}`, title, tone: "muted" };
}
function syncItem(store, status, now = Date.now(), workspace = null) {
  if (!store || store.kind === "project" || store.unavailable) return null;
  if (workspace?.state === "unreachable") {
    const when2 = workspace.lastSyncedAt ? relativeTime(workspace.lastSyncedAt, now) : "";
    return { label: `Store unreachable \xB7 ${when2 ? `last synced ${when2}` : "never synced"}`, tone: "danger", problem: true, message: workspace.message };
  }
  if (workspace && !Object.hasOwn(PROBLEMS, status?.state)) {
    if (workspace.state === "syncing" && !workspace.lastSyncedAt) return { label: "Syncing\u2026", tone: "muted", problem: false };
    if (workspace.lastSyncedAt) return { label: `Synced ${relativeTime(workspace.lastSyncedAt, now)}`, tone: "ok", problem: false };
  }
  if (!store.sync) return { label: "Sync off", tone: "muted", problem: false };
  if (!status) return { label: "Not synced yet", tone: "muted", problem: false };
  const when = relativeTime(status.at, now);
  const problem = Object.hasOwn(PROBLEMS, status.state);
  return { label: `${STATES[status.state] ?? status.state}${when ? `${problem ? " \xB7 " : " "}${when}` : ""}`, tone: problem ? status.state === "conflicts" ? "warn" : "danger" : "ok", problem };
}
function storeFacts(store, status, workspace = null) {
  const where = store.kind === "project" ? `In this checkout, <code>${escapeHtml(store.label)}</code>` : `${store.kind === "remote" ? "Remote store" : "Store folder"} <code>${escapeHtml(store.label)}</code>`;
  return keyValues([
    ["Records", where],
    ["Folder", store.location && store.kind !== "project" ? `<code>${escapeHtml(store.location)}</code>` : null],
    ["Sync", store.kind === "project" ? null : store.sync ? "on" : "off"],
    ["Last sync", status ? `${escapeHtml(STATES[status.state] ?? status.state)} \xB7 <prism-time datetime="${escapeHtml(status.at)}"></prism-time> <span class="muted">(${escapeHtml(formatTime(status.at))})</span>` : null],
    ["Last fetched", workspace ? workspace.lastSyncedAt ? `<prism-time datetime="${escapeHtml(workspace.lastSyncedAt)}"></prism-time> <span class="muted">(${escapeHtml(formatTime(workspace.lastSyncedAt))})</span>` : "Not yet" : null],
    ["Next fetch", workspace?.nextFetchAt ? escapeHtml(formatTime(workspace.nextFetchAt)) : null],
    ["Ahead", status?.ahead ? plural(status.ahead, "local commit") : null],
    ["Behind", status?.behind ? plural(status.behind, "upstream commit") : null]
  ]);
}
function recordName(path, describe) {
  const named = describe(`.prism/${path}`);
  return named.label === named.kind ? named.kind : `${named.kind} \xB7 ${named.label}`;
}
function conflictsHtml(conflicts, status, describe) {
  if (!conflicts.length) return '<p class="muted">No saved conflicts in this store.</p>';
  const latest = new Set((status?.conflicts ?? []).map((item) => item.savedAs).filter(Boolean));
  return `<ul class="conflict-list">${conflicts.map((item) => `
    <li><prism-disclosure class="conflict" data-saved-as="${escapeHtml(item.savedAs)}" summary="${escapeHtml(`${recordName(item.path, describe)} \xB7 saved ${relativeTime(item.at)}${latest.has(item.savedAs) ? " \xB7 latest sync" : ""}`)}">
      <div class="conflict-body"><p class="muted">Loading the saved copy\u2026</p></div>
    </prism-disclosure></li>`).join("")}</ul>`;
}
function unsavedHtml(status, describe) {
  const unsaved = (status?.conflicts ?? []).filter((item) => !item.savedAs);
  return unsaved.length ? `<p class="muted">Deleted locally while the upstream changed ${unsaved.map((item) => escapeHtml(recordName(item.path, describe))).join(", ")}; the upstream version was kept and nothing was saved.</p>` : "";
}
function createRecordStoreStatus({ storeButton, storeLabel, syncPart, syncLabel, dialog, fetchJson, openRecord, hasArtifact, describe = (path) => ({ label: path, kind: "Record" }) }) {
  let store = null;
  let status = null;
  let workspace = null;
  const content = document.createElement("div");
  content.className = "store-details";
  dialog.append(content);
  everyMinute(() => update(store, status, workspace));
  function update(nextStore, nextStatus, nextWorkspace = null) {
    store = nextStore ?? null;
    status = nextStatus ?? null;
    workspace = nextWorkspace ?? null;
    const where = storeItem(store);
    storeButton.hidden = !where;
    if (!where) return;
    const sync = syncItem(store, status, Date.now(), workspace);
    storeLabel.textContent = where.short;
    syncPart.hidden = !sync;
    if (sync) syncLabel.textContent = sync.label;
    storeButton.dataset.tone = sync?.tone ?? where.tone;
    const tone = sync?.tone ?? where.tone;
    const storeIcon = storeButton.querySelector("prism-icon");
    if (tone === "muted") storeIcon?.removeAttribute("tone");
    else storeIcon?.setAttribute("tone", tone);
    storeButton.dataset.name = where.short;
    const tip = [where.title, sync ? [sync.label, sync.message ?? status?.message].filter(Boolean).join(": ") : "", sync?.problem ? "Click for details" : ""];
    storeButton.setAttribute("tip", tip.filter(Boolean).join("\n"));
  }
  async function open() {
    if (!store) return;
    const sync = syncItem(store, status, Date.now(), workspace);
    const problem = sync?.problem;
    content.innerHTML = `<div class="store-details-body">
        ${store.unavailable ? `<p class="store-message is-danger">${escapeHtml(store.unavailable)}</p>` : ""}
        ${store.awaitingMove?.message ? `<p class="store-message is-warn">${escapeHtml(store.awaitingMove.message)}</p>` : ""}
        ${store.keptInCheckout?.message ? `<p class="store-message" data-kept-in-checkout>${escapeHtml(store.keptInCheckout.message)}</p>` : ""}
        ${sync?.message ? `<p class="store-message is-danger" data-unreachable>${escapeHtml(sync.message)}</p>` : problem && status?.message ? `<p class="store-message ${status.state === "conflicts" ? "is-warn" : "is-danger"}">${escapeHtml(status.message)}</p>` : ""}
        ${storeFacts(store, status, workspace)}
        ${store.kind === "project" ? "" : `<section class="store-conflicts"><h3>Saved conflicts</h3>
          <p class="muted">When two checkouts change the same record, the sync keeps the upstream version and saves the local one. Compare them to redo a lost change through an agent.</p>
          ${unsavedHtml(status, describe)}<div data-conflicts><p class="muted">Loading\u2026</p></div></section>`}
      </div>`;
    if (!dialog.isOpen) dialog.show();
    const holder = content.querySelector("[data-conflicts]");
    if (!holder) return;
    let conflicts = [];
    try {
      conflicts = (await fetchJson("./api/store/conflicts")).conflicts;
    } catch {
      holder.innerHTML = '<p class="error">The saved conflicts could not be listed.</p>';
      return;
    }
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
      if (conflict.tooLarge) {
        const sizes = [["saved local copy", conflict.tooLarge.saved], ["current record", conflict.tooLarge.current]].filter(([, size]) => size !== void 0);
        body.innerHTML = `<p class="muted">${sizes.map(([what, size]) => `The ${what} ${size === null ? "is no regular file" : `holds ${size} bytes`}, above the ${conflict.bound} bytes that a record of its kind may hold, so Prism does not read it.`).join(" ")} The saved copy stays at ${escapeHtml(details.dataset.savedAs)}.</p>`;
        return;
      }
      body.innerHTML = `${conflict.current === null ? '<p class="muted">The record no longer exists, so every saved line shows as added.</p>' : ""}
        ${diffHtml(conflict.current, conflict.saved, { beforeLabel: "current record", afterLabel: "saved local copy" })}
        ${conflict.current !== null && hasArtifact(record) ? `<p><prism-button size="sm" data-record="${escapeHtml(record)}">Open the current record</prism-button></p>` : ""}`;
      body.querySelector("[data-record]")?.addEventListener("click", () => {
        dialog.close();
        openRecord(record);
      });
    } catch {
      body.innerHTML = '<p class="error">The saved copy could not be read.</p>';
    }
  }
  storeButton.addEventListener("click", open);
  return { update };
}
export {
  createRecordStoreStatus,
  storeItem,
  syncItem
};
