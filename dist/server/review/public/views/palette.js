// The command palette: a glass dialog whose search field drives a listbox of results grouped by kind, Prism's records named by title and kind,
// a slice's result carrying its claim, repository files in a Files group, and full-text matches in Prism's documents after them.
// Above 720px a preview of the active result sits beside the results.
import { claimElement } from "./claim-index.js";

const KIND_ORDER = ["action", "place", "initiative", "slice", "requirement", "decision", "term", "record", "file"];
const GROUPS = { action: "Settings on this page", place: "Places", initiative: "Initiatives", slice: "Slices", requirement: "Requirements", decision: "Decisions", term: "Glossary terms", record: "Records", file: "Files", text: "Text in documents", code: "Code in indexed components" };
// Why a workspace's search left a component out, as the left-out list names it.
const LEFT_OUT = { no_checkout: "no checkout here", no_index: "no ready index", search_failed: "search failed" };
const KINDS = { action: "Setting", place: "Place", initiative: "Initiative", slice: "Slice", requirement: "Requirement", decision: "Decision", term: "Term", file: "File", code: "Code" };
const RESULT_LIMIT = 40;
const TEXT_SEARCH_DELAY_MS = 200;
const TEXT_SEARCH_MINIMUM = 3;

function rank(entry, query, tokens) {
  const label = entry.label.toLowerCase();
  const haystack = `${label} ${String(entry.detail ?? "").toLowerCase()} ${String(entry.kindLabel ?? "").toLowerCase()} ${String(entry.scope ?? "").toLowerCase()} ${entry.ref.toLowerCase()}`;
  if (!tokens.every((token) => haystack.includes(token))) return null;
  const position = label.startsWith(query) ? 0 : label.includes(query) ? 1 : 2;
  return [KIND_ORDER.indexOf(entry.kind), position, label.length];
}

function compare(left, right) {
  for (let index = 0; index < left.rank.length; index += 1) {
    if (left.rank[index] !== right.rank[index]) return left.rank[index] - right.rank[index];
  }
  return 0;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** The kind a result shows: a record's own kind, such as Design or Change map, or the kind of entity. */
export function kindOf(entry) {
  return entry.kindLabel ?? KINDS[entry.kind] ?? entry.kind;
}

/**
 * `dialog` is a prism-dialog, `field` a prism-field of type search, `results` a prism-listbox for that field, and `preview` the pane beside them.
 * `entries()` lists what the palette can jump to; `search(query)` finds text in documents; `describe(path)` names a document by title and kind;
 * `claimFor(ref)` gives a slice's claim; `onOpen(ref, { find })` opens a result.
 */
export function createPalette({ dialog, field, results, preview, entries, onOpen, search = null, describe = (path) => ({ label: path, kind: "Document" }), claimFor = () => null }) {
  let matches = [];
  let textMatches = [];
  let codeMatches = [];
  let leftOut = [];
  let textState = "idle";
  let searchTimer = 0;
  let searchRequest = 0;
  let rendered = "";

  const query = () => (field.value ?? "").trim();

  function update() {
    const text = query().toLowerCase();
    const tokens = text.split(/\s+/).filter(Boolean);
    const all = entries();
    matches = text
      ? all.map((entry) => ({ entry, rank: rank(entry, text, tokens) })).filter((item) => item.rank).sort(compare).slice(0, RESULT_LIMIT).map((item) => item.entry)
      : all.filter((entry) => entry.kind === "action" || entry.kind === "place" || entry.kind === "initiative").slice(0, RESULT_LIMIT);
    textMatches = [];
    codeMatches = [];
    leftOut = [];
    clearTimeout(searchTimer);
    const current = ++searchRequest;
    textState = search && text.length >= TEXT_SEARCH_MINIMUM ? "searching" : "idle";
    if (textState === "searching") {
      searchTimer = setTimeout(async () => {
        let answer = [];
        try {
          answer = await search(query());
        } catch {
          answer = [];
        }
        if (current !== searchRequest) return;
        // A workspace's search answers { results, code, leftOut }: code matches of the indexed components and the components it left out, beside the documents.
        const found = Array.isArray(answer) ? answer : answer.results ?? [];
        codeMatches = Array.isArray(answer) ? [] : (answer.code ?? []).map((match) => ({ ref: match.ref, kind: "code", label: match.file, code: true, detail: String(match.excerpt ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? "", line: match.range?.startLine ?? null, find: null, scope: match.component }));
        leftOut = Array.isArray(answer) ? [] : answer.leftOut ?? [];
        textMatches = found.flatMap((result) => result.matches.slice(0, 1).map((match) => {
          const named = describe(result.path);
          // As in the Records group, a record that belongs to a slice or initiative reads as its kind, and the preview names its owner.
          const owned = !named.code && named.owner && named.label !== named.kind;
          const label = owned ? named.kind : named.label;
          return { ref: result.path, kind: "text", label, kindLabel: owned ? "Record" : named.kind, code: Boolean(named.code), detail: match.text, line: match.line, find: query(), scope: result.scope ?? null, preview: owned ? { kind: named.kind, title: named.owner } : null };
        }));
        textState = "done";
        render({ keep: true });
      }, TEXT_SEARCH_DELAY_MS);
    }
    render({ keep: false });
  }

  const all = () => [...matches, ...textMatches, ...codeMatches];

  function option(entry, index) {
    const code = entry.kind === "file" || entry.code;
    const item = node("prism-list-item", code ? "palette-result is-code" : "palette-result");
    item.setAttribute("value", String(index));
    // A repository file found by its text keeps its path, as the Files group does.
    if (entry.code && entry.kind !== "file") item.dataset.codeSubject = "";
    item.append(entry.label);
    const meta = node("span", "palette-meta");
    meta.slot = "meta";
    const claim = entry.kind === "slice" ? claimFor(entry.ref) : null;
    if (claim) meta.append(claimElement(claim, "inline"), " ");
    // A store artifact's row names its scope, so artifacts of one name in several scopes read apart in the list itself.
    if (entry.scope) {
      const scope = node("prism-chip", "", entry.scope);
      scope.dataset.scopeLabel = "";
      meta.append(scope, " ");
    }
    meta.append(node("span", "palette-kind", kindOf(entry)));
    item.append(meta);
    return item;
  }

  function group(kind, items, label = GROUPS[kind] ?? kind) {
    const holder = node("div", "palette-group");
    holder.setAttribute("role", "group");
    holder.setAttribute("aria-label", label);
    // Repository files are where code is the subject, so they keep their paths.
    if (kind === "file") holder.dataset.codeSubject = "";
    holder.append(node("div", "palette-group-label", label), ...items);
    return holder;
  }

  // The components a workspace's search left out, each a chip that names it and why, so a missing code match reads as not searched rather than absent.
  function leftOutGroup() {
    const holder = node("div", "palette-group");
    holder.dataset.leftOut = "";
    const chips = node("div", "palette-left-out");
    for (const item of leftOut) {
      const chip = node("prism-chip", "", item.component);
      chip.dataset.leftOutComponent = item.component;
      chip.dataset.codeSubject = "";
      chip.append(node("span", "", LEFT_OUT[item.reason] ?? item.reason));
      chip.lastChild.slot = "meta";
      chips.append(chip);
    }
    holder.append(node("div", "palette-group-label", "Left out of this search"), chips);
    return holder;
  }

  function render({ keep }) {
    const active = keep ? results.active?.getAttribute("value") ?? null : null;
    const list = all();
    const key = JSON.stringify([list.map((entry) => [entry.ref, entry.kind, entry.label, entry.line ?? null]), leftOut, textState]);
    if (key === rendered) return;
    rendered = key;
    const groups = [];
    let index = 0;
    for (const kind of KIND_ORDER) {
      const items = matches.filter((entry) => entry.kind === kind);
      if (!items.length) continue;
      groups.push(group(kind, items.map((entry) => option(entry, matches.indexOf(entry)))));
      index += items.length;
    }
    if (textState === "searching") groups.push(node("p", "palette-status", "Searching text…"));
    else if (textState === "done" && textMatches.length) groups.push(group("text", textMatches.map((entry, offset) => option(entry, index + offset))));
    else if (textState === "done" && !list.length) groups.push(node("p", "palette-status", "No text matches."));
    if (textState === "done" && codeMatches.length) groups.push(group("code", codeMatches.map((entry, offset) => option(entry, index + textMatches.length + offset))));
    if (textState === "done" && leftOut.length) groups.push(leftOutGroup());
    if (!list.length && textState !== "searching" && textState !== "done") groups.push(node("p", "palette-status", "Nothing matches."));
    results.replaceChildren(...groups);
    results.activate(active);
    showPreview();
  }

  // Until an arrow key picks a result, the first one stands in for it: the preview shows it and Enter opens it.
  // The listbox keeps no active option then, so the first ArrowDown still lands on the first result.
  const current = () => results.active ?? results.options[0] ?? null;

  function showPreview() {
    const entry = all()[Number(current()?.getAttribute("value"))];
    if (!entry) {
      preview.replaceChildren(node("p", "palette-preview-hint", "ArrowDown and ArrowUp move through the results, and Enter opens one."));
      return;
    }
    const code = entry.kind === "file" || entry.code;
    const title = node("h3", "palette-preview-title", entry.preview?.title ?? entry.label);
    if (code) title.dataset.codeSubject = "";
    const parts = [node("p", "palette-preview-kind", entry.preview?.kind ?? kindOf(entry)), title];
    if (entry.detail && entry.detail !== entry.preview?.title) {
      const detail = node("p", "palette-preview-detail", (entry.kind === "text" || entry.kind === "code") && entry.line ? `Line ${entry.line}: ${entry.detail}` : entry.detail);
      // A file's path, and a line of a document's text, are quoted as they are.
      if (code || entry.kind === "text") detail.dataset.codeSubject = "";
      parts.push(detail);
    }
    const claim = entry.kind === "slice" ? claimFor(entry.ref) : null;
    if (claim) parts.push(claimElement(claim, "inline"));
    preview.replaceChildren(...parts);
  }

  function choose(index) {
    const entry = all()[index];
    if (!entry) return;
    hide();
    // An action entry of the shown page moves focus to that action's control instead of opening anything.
    if (entry.run) entry.run();
    else onOpen(entry.ref, { find: entry.find ?? null });
  }

  function show() {
    rendered = "";
    field.value = "";
    update();
    dialog.show();
    field.control?.focus();
  }

  function hide() {
    clearTimeout(searchTimer);
    searchRequest += 1;
    dialog.close();
  }

  field.addEventListener("input", update);
  // A search field clears its text on Escape before a dialog sees the key, so the palette closes on the first Escape itself.
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hide();
    } else if (event.key === "Enter" && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !results.active && current()) {
      event.preventDefault();
      results.choose(current());
    }
  });
  results.addEventListener("prism-select", (event) => choose(Number(event.detail?.value)));
  new MutationObserver(showPreview).observe(results, { subtree: true, attributes: true, attributeFilter: ["active"] });
  return { show, hide, isOpen: () => dialog.isOpen };
}
