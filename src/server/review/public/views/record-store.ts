import { relativeTime } from "./indexing.js";
import { everyMinute } from "../kit/claim-time.js";
import { diffHtml } from "./line-diff.js";
import { escapeHtml, formatTime, keyValues, plural } from "./util.js";

const PROBLEMS = { no_upstream: "Records not shared", not_a_repository: "Records not synced", push_rejected: "Records not pushed", merge_failed: "Records not merged", fetch_failed: "Records not fetched", git_failed: "Records not synced", conflicts: "Record conflicts saved" };
const STATES: Record<string, any> = { ok: "Synced", ...PROBLEMS };

// A store's short name: the last part of its folder or remote, without a .git ending.
function storeName(label: string) {
  const parts = String(label ?? "").replace(/[\\/]+$/, "").split(/[\\/:]/).filter(Boolean);
  return (parts.at(-1) ?? String(label ?? "")).replace(/\.git$/, "");
}

/** Where the records live: { label, short, title, tone }, where the status bar shows short and its tip title. */
export function storeItem(store: any) {
  if (!store) return null;
  if (store.kind === "project") return { label: "Records in project", short: "Records in project", title: `Records live in this checkout's ${store.label} folder.`, tone: "muted" };
  const noun = store.kind === "remote" ? "Remote store" : "Store";
  if (store.unavailable) return { label: `${noun} unavailable`, short: "Shared store unavailable", title: store.unavailable, tone: "danger" };
  const title = [`Records live in the ${store.kind === "remote" ? "store named by its remote" : "store folder"} ${store.label}.`, store.location ? `Folder: ${store.location}` : ""].filter(Boolean).join("\n");
  // Tracked files that still wait in the checkout for an agent's tool call to move them are named beside the store as a warning, since the browser lists only the store's artifacts,
  // and files that a move kept for a person to settle as a plain note, since no tool call moves them.
  const name = store.workspaceName ?? storeName(store.label);
  const waiting = store.awaitingMove?.files;
  const kept = store.keptInCheckout?.files;
  const details = [title, store.awaitingMove?.message, store.keptInCheckout?.message].filter(Boolean).join("\n");
  if (waiting) return { label: `${noun} ${store.label} · ${plural(waiting, "file")} to move`, short: `Shared store ${name} · ${plural(waiting, "file")} to move`, title: details, tone: "warn" };
  if (kept) return { label: `${noun} ${store.label} · ${plural(kept, "file")} kept in checkout`, short: `Shared store ${name} · ${plural(kept, "file")} kept in checkout`, title: details, tone: "muted" };
  // The status bar names the shared store at a glance, by the workspace name when it has one; its tip and the details say where it lives.
  return { label: `${noun} ${store.label}`, short: `Shared store ${name}`, title, tone: "muted" };
}

/**
 * The store's sync state, as the status bar names it, or null when nothing syncs: { label, tone, problem, message }.
 * workspace is the open workspace's own fetch state, when the app keeps its store in sync: an unreachable store names when it last synced, and a problem of the last record sync wins over a fetch that went through.
 */
export function syncItem(store: any, status: any, now = Date.now(), workspace = null) {
  if (!store || store.kind === "project" || store.unavailable) return null;
  if ((workspace as any)?.state === "unreachable") {
    const when = (workspace as any).lastSyncedAt ? relativeTime((workspace as any).lastSyncedAt, now) : "";
    return { label: `Store unreachable · ${when ? `last synced ${when}` : "never synced"}`, tone: "danger", problem: true, message: (workspace as any).message };
  }
  if (workspace && !Object.hasOwn(PROBLEMS, status?.state)) {
    if ((workspace as any).state === "syncing" && !(workspace as any).lastSyncedAt) return { label: "Syncing…", tone: "muted", problem: false };
    if ((workspace as any).lastSyncedAt) return { label: `Synced ${relativeTime((workspace as any).lastSyncedAt, now)}`, tone: "ok", problem: false };
  }
  if (!store.sync) return { label: "Sync off", tone: "muted", problem: false };
  if (!status) return { label: "Not synced yet", tone: "muted", problem: false };
  const when = relativeTime(status.at, now);
  const problem = Object.hasOwn(PROBLEMS, status.state);
  return { label: `${STATES[status.state] ?? status.state}${when ? `${problem ? " · " : " "}${when}` : ""}`, tone: problem ? (status.state === "conflicts" ? "warn" : "danger") : "ok", problem };
}

// How quickly a change made outside Prism shows: at once where every record folder is watched, and within the listing interval elsewhere.
const CHECK_SECONDS = 5;
const COUNTS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const REASONS: Record<string, string> = {
  wsl: "A Windows drive seen from WSL, which reports no changes made from Windows",
  virtual: "A virtual machine's shared folder, which reports no changes made outside it",
  network: "A network drive, which reports no changes made on other computers",
  unwatchable: "Prism could not watch this folder"
};

/** What the store's details say about changes made outside Prism: { row, message, folders }, or null when the server did not say. */
export function outsideChanges(watching: any) {
  if (!watching || !Array.isArray(watching.unwatched)) return null;
  const unwatched = watching.unwatched;
  if (unwatched.length === 0) return { row: "Shown at once", message: null, folders: [] };
  if (unwatched.every((item: any) => item.reason === "windows")) {
    return { row: `Checked every ${CHECK_SECONDS} seconds`, message: `On Windows, a folder that Prism watches can't be moved or deleted, so Prism checks this workspace's folders instead. A change made by another app can take up to ${CHECK_SECONDS} seconds to show. Changes made through Prism show at once.`, folders: [] };
  }
  const count = unwatched.length < COUNTS.length ? COUNTS[unwatched.length] : String(unwatched.length);
  const noun = unwatched.length === 1 ? "folder" : "folders";
  const all = unwatched.length >= watching.targets;
  return {
    row: all ? `Checked every ${CHECK_SECONDS} seconds` : `Shown at once, except ${count.toLowerCase()} ${noun} checked every ${CHECK_SECONDS} seconds`,
    message: `${count} ${noun} can't be watched, so Prism checks ${unwatched.length === 1 ? "it" : "them"} every ${CHECK_SECONDS} seconds instead. A change made there by another app or computer can take up to ${CHECK_SECONDS} seconds to show. Changes made through Prism show at once.`,
    folders: unwatched.map((item: any) => ({ path: String(item.path), reason: REASONS[item.reason] ?? REASONS.unwatchable }))
  };
}

function outsideFoldersHtml(outside: any) {
  if (!outside?.folders.length) return "";
  return `<section class="store-unwatched"><h3>Folders checked instead of watched</h3>${keyValues(outside.folders.map((folder: any) => ["Folder", `<code>${escapeHtml(folder.path)}</code><br><span class="muted">${escapeHtml(folder.reason)}</span>`]))}</section>`;
}

function storeFacts(store: any, status: any, workspace = null) {
  const where = store.kind === "project" ? `In this checkout, <code>${escapeHtml(store.label)}</code>` : `${store.kind === "remote" ? "Remote store" : "Store folder"} <code>${escapeHtml(store.label)}</code>`;
  return keyValues([
    ["Records", where],
    ["Folder", store.location && store.kind !== "project" ? `<code>${escapeHtml(store.location)}</code>` : null],
    ["Sync", store.kind === "project" ? null : store.sync ? "on" : "off"],
    ["Last sync", status ? `${escapeHtml(STATES[status.state] ?? status.state)} · <prism-time datetime="${escapeHtml(status.at)}"></prism-time> <span class="muted">(${escapeHtml(formatTime(status.at))})</span>` : null],
    ["Last fetched", workspace ? (workspace as any).lastSyncedAt ? `<prism-time datetime="${escapeHtml((workspace as any).lastSyncedAt)}"></prism-time> <span class="muted">(${escapeHtml(formatTime((workspace as any).lastSyncedAt))})</span>` : "Not yet" : null],
    ["Next fetch", (workspace as any)?.nextFetchAt ? escapeHtml(formatTime((workspace as any).nextFetchAt)) : null],
    ["Ahead", status?.ahead ? plural(status.ahead, "local commit") : null],
    ["Behind", status?.behind ? plural(status.behind, "upstream commit") : null],
    ["Outside changes", outsideChanges(store.watching)?.row ? escapeHtml(outsideChanges(store.watching)!.row) : null]
  ]);
}

// A saved conflict names its record by title and kind, such as Coordination state · Harden request retries.
function recordName(path: any, describe: any) {
  const named = describe(`.prism/${path}`);
  return named.label === named.kind ? named.kind : `${named.kind} · ${named.label}`;
}

function conflictsHtml(conflicts: any, status: any, describe: any) {
  if (!conflicts.length) return '<p class="muted">No saved conflicts in this store.</p>';
  const latest = new Set((status?.conflicts ?? []).map((item: any) => item.savedAs).filter(Boolean));
  return `<ul class="conflict-list">${conflicts.map((item: any) => `
    <li><prism-disclosure class="conflict" data-saved-as="${escapeHtml(item.savedAs)}" summary="${escapeHtml(`${recordName(item.path, describe)} · saved ${relativeTime(item.at)}${latest.has(item.savedAs) ? " · latest sync" : ""}`)}">
      <div class="conflict-body"><p class="muted">Loading the saved copy…</p></div>
    </prism-disclosure></li>`).join("")}</ul>`;
}

// A record the local side deleted while the upstream changed it has no saved copy, so the latest status names it alone.
function unsavedHtml(status: any, describe: any) {
  const unsaved = (status?.conflicts ?? []).filter((item: any) => !item.savedAs);
  return unsaved.length ? `<p class="muted">Deleted locally while the upstream changed ${unsaved.map((item: any) => escapeHtml(recordName(item.path, describe))).join(", ")}; the upstream version was kept and nothing was saved.</p>` : "";
}

// One status bar button names the store and, beside it, its sync state; both open the same details, so they are one control.
// Its tone is the sync state's, and its tip says where the records live, then the sync message.
export function createRecordStoreStatus({ storeButton, storeLabel, syncPart, syncLabel, dialog, fetchJson, openRecord, hasArtifact, describe = (path: any) => ({ label: path, kind: "Record" }) }: { storeButton: any; storeLabel: any; syncPart: any; syncLabel: any; dialog: any; fetchJson: any; openRecord: any; hasArtifact: any; describe?: any }) {
  let store: any = null;
  let status: any = null;
  let workspace: any = null;
  // The dialog keeps its own header and Close button, so the details render into one holder in its body.
  const content = document.createElement("div");
  content.className = "store-details";
  dialog.append(content);

  // The status bar's "Synced 5 min ago" counts on with the clock, also between syncs.
  everyMinute(() => update(store, status, workspace));

  function update(nextStore: any, nextStatus: any, nextWorkspace = null) {
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
    // The store's icon takes the sync state's color, so the bar says whether records are safe without a dot of its own.
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
    const outside = outsideChanges(store.watching);
    content.innerHTML = `<div class="store-details-body">
        ${store.unavailable ? `<p class="store-message is-danger">${escapeHtml(store.unavailable)}</p>` : ""}
        ${store.awaitingMove?.message ? `<p class="store-message is-warn">${escapeHtml(store.awaitingMove.message)}</p>` : ""}
        ${store.keptInCheckout?.message ? `<p class="store-message" data-kept-in-checkout>${escapeHtml(store.keptInCheckout.message)}</p>` : ""}
        ${sync?.message ? `<p class="store-message is-danger" data-unreachable>${escapeHtml(sync.message)}</p>` : problem && status?.message ? `<p class="store-message ${status.state === "conflicts" ? "is-warn" : "is-danger"}">${escapeHtml(status.message)}</p>` : ""}
        ${outside?.message ? `<p class="store-message" data-outside-changes>${escapeHtml(outside.message)}</p>` : ""}
        ${storeFacts(store, status, workspace)}
        ${outsideFoldersHtml(outside)}
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

  async function loadConflict(details: any) {
    if (details.dataset.loaded) return;
    details.dataset.loaded = "true";
    const body = details.querySelector(".conflict-body");
    try {
      const conflict = await fetchJson(`./api/store/conflict?savedAs=${encodeURIComponent(details.dataset.savedAs)}`);
      const record = `.prism/${conflict.path}`;
      // A copy or record above its kind's bound is named by its size and never read, so no diff can show it.
      if (conflict.tooLarge) {
        const sizes = [["saved local copy", conflict.tooLarge.saved], ["current record", conflict.tooLarge.current]].filter(([, size]) => size !== undefined);
        body.innerHTML = `<p class="muted">${sizes.map(([what, size]) => `The ${what} ${size === null ? "is no regular file" : `holds ${size} bytes`}, above the ${conflict.bound} bytes that a record of its kind may hold, so Prism does not read it.`).join(" ")} The saved copy stays at ${escapeHtml(details.dataset.savedAs)}.</p>`;
        return;
      }
      body.innerHTML = `${conflict.current === null ? '<p class="muted">The record no longer exists, so every saved line shows as added.</p>' : ""}
        ${diffHtml(conflict.current, conflict.saved, { beforeLabel: "current record", afterLabel: "saved local copy" })}
        ${conflict.current !== null && hasArtifact(record) ? `<p><prism-button size="sm" data-record="${escapeHtml(record)}">Open the current record</prism-button></p>` : ""}`;
      body.querySelector("[data-record]")?.addEventListener("click", () => { dialog.close(); openRecord(record); });
    } catch {
      body.innerHTML = '<p class="error">The saved copy could not be read.</p>';
    }
  }

  storeButton.addEventListener("click", open);
  return { update };
}
