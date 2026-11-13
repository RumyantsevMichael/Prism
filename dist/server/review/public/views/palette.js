// The command palette: a glass dialog that hangs below the top bar, whose search row drives a listbox of results grouped by kind,
// Prism's records named by title and kind, a slice's result carrying its claim, full-text matches in Prism's documents, and repository files.
// Filters above the results narrow them to one kind; above 720px a preview of the current result sits beside them, and a footer names the keys and the count.
import { claimElement } from "./claim-index.js";

const KIND_ORDER = ["action", "place", "slice", "initiative", "requirement", "decision", "record", "term", "file"];
// Requirements, decisions, and Prism's other records read as documents, so they share one group.
const GROUP_OF = { requirement: "document", decision: "document", record: "document" };
const GROUPS = { action: "Settings on this page", place: "Places", initiative: "Initiatives", slice: "Slices", document: "Documents", term: "Glossary terms", file: "Files", text: "Text matches" };
const GROUP_ORDER = ["action", "place", "slice", "initiative", "document", "term", "text", "file"];
const KINDS = { action: "Setting", place: "Place", initiative: "Initiative", slice: "Slice", requirement: "Requirement", decision: "Decision", term: "Term", file: "File" };
// Each filter keeps the kinds it names; All keeps every result, and Text keeps the matches in documents only.
const SCOPES = [
  { value: "all", label: "All", kinds: null },
  { value: "slices", label: "Slices", kinds: ["slice"] },
  { value: "initiatives", label: "Initiatives", kinds: ["initiative"] },
  { value: "documents", label: "Documents", kinds: ["requirement", "decision", "record", "term"] },
  { value: "files", label: "Files", kinds: ["file"] },
  { value: "text", label: "Text", kinds: ["text"] }
];
const PLACE_ICONS = { attention: "bell", roadmap: "roadmap", requirements: "list", decisions: "scale", glossary: "book", launches: "agent" };
const KIND_ICONS = { action: "filter", initiative: "roadmap", slice: "layers", requirement: "list", decision: "scale", term: "book", record: "document", file: "code", text: "document" };
const RESULT_LIMIT = 40;
const TEXT_SEARCH_DELAY_MS = 200;
const TEXT_SEARCH_MINIMUM = 3;

function rank(entry, query, tokens) {
  const label = entry.label.toLowerCase();
  const haystack = `${label} ${String(entry.detail ?? "").toLowerCase()} ${String(entry.kindLabel ?? "").toLowerCase()} ${entry.ref.toLowerCase()}`;
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

function icon(name, slot) {
  const glyph = document.createElement("prism-icon");
  glyph.setAttribute("name", name);
  glyph.setAttribute("size", "sm");
  if (slot) glyph.slot = slot;
  return glyph;
}

/** The kind a result shows: a record's own kind, such as Design or Change map, or the kind of entity. */
export function kindOf(entry) {
  return entry.kindLabel ?? KINDS[entry.kind] ?? entry.kind;
}

/** Text as nodes with each occurrence of a query word wrapped in <mark>, case ignored. */
export function highlighted(text, tokens) {
  const words = [...new Set(tokens.filter(Boolean))].sort((left, right) => right.length - left.length);
  if (!words.length) return [document.createTextNode(text)];
  const lower = text.toLowerCase();
  const parts = [];
  let at = 0;
  while (at < text.length) {
    let found = -1;
    let word = "";
    for (const candidate of words) {
      const index = lower.indexOf(candidate, at);
      if (index >= 0 && (found < 0 || index < found)) {
        found = index;
        word = candidate;
      }
    }
    if (found < 0) break;
    if (found > at) parts.push(document.createTextNode(text.slice(at, found)));
    parts.push(node("mark", "", text.slice(found, found + word.length)));
    at = found + word.length;
  }
  if (at < text.length) parts.push(document.createTextNode(text.slice(at)));
  return parts;
}

// A record's state reads as words, so "in-progress" shows as "in progress".
const words = (text) => String(text ?? "").replace(/-/g, " ");

// The second line of a result: where it belongs and its state, as the index names them.
function detailOf(entry) {
  // A text match names its document's kind and line; its owner stays in the preview, so the row's name never repeats another result's title.
  if (entry.kind === "text") return [entry.kindLabel, entry.line ? `Line ${entry.line}` : ""].filter(Boolean).join(" · ");
  if (entry.kind === "requirement" || entry.kind === "decision") return [kindOf(entry), entry.detail].filter(Boolean).join(" · ");
  // A slice's or an initiative's record shows its owner to the eye, and the row's name leaves it to the preview, so it never repeats the owner's title.
  if (entry.kind === "record") return "";
  return words(entry.detail);
}

/**
 * `dialog` is a prism-dialog, `field` a prism-field of type search, `results` a prism-listbox for that field, `preview` the pane beside them,
 * `scopes` the holder of the filters, and `count` the footer's count of results.
 * `entries()` lists what the palette can jump to; `search(query)` finds text in documents; `describe(path)` names a document by title and kind;
 * `claimFor(ref)` gives a slice's claim; `onOpen(ref, { find, keep })` opens a result, where keep says Ctrl+Enter, Meta+Enter, or a Ctrl-click or Cmd-click chose it.
 */
export function createPalette({ dialog, field, results, preview, scopes = null, count = null, entries, onOpen, search = null, describe = (path) => ({ label: path, kind: "Document" }), claimFor = () => null }) {
  let matches = [];
  let total = 0;
  let textMatches = [];
  let textState = "idle";
  let searchTimer = 0;
  let searchRequest = 0;
  let rendered = "";
  let scope = SCOPES[0];

  const query = () => (field.value ?? "").trim();
  const tokens = () => query().toLowerCase().split(/\s+/).filter(Boolean);
  const kept = (kind) => !scope.kinds || scope.kinds.includes(kind);

  const scopeButtons = SCOPES.map((item) => {
    const button = document.createElement("prism-button");
    button.setAttribute("size", "sm");
    button.setAttribute("shape", "round");
    button.setAttribute("pressed", String(item === scope));
    button.dataset.scope = item.value;
    button.textContent = item.label;
    button.addEventListener("click", () => {
      scope = item;
      for (const other of scopeButtons) other.setAttribute("pressed", String(other.dataset.scope === item.value));
      rendered = "";
      update();
      field.control?.focus();
    });
    return button;
  });
  scopes?.replaceChildren(...scopeButtons);

  function update() {
    const text = query().toLowerCase();
    const words = tokens();
    const all = entries().filter((entry) => kept(entry.kind));
    const found = text
      ? all.map((entry) => ({ entry, rank: rank(entry, text, words) })).filter((item) => item.rank).sort(compare).map((item) => item.entry)
      : all.filter((entry) => scope.kinds || entry.kind === "action" || entry.kind === "place" || entry.kind === "initiative");
    total = found.length;
    matches = found.slice(0, RESULT_LIMIT);
    textMatches = [];
    clearTimeout(searchTimer);
    const current = ++searchRequest;
    textState = search && kept("text") && text.length >= TEXT_SEARCH_MINIMUM ? "searching" : "idle";
    if (textState === "searching") {
      searchTimer = setTimeout(async () => {
        let found = [];
        try {
          found = await search(query());
        } catch {
          found = [];
        }
        if (current !== searchRequest) return;
        textMatches = found.flatMap((result) => result.matches.slice(0, 1).map((match) => {
          const named = describe(result.path);
          // As in the Documents group, a record that belongs to a slice or initiative reads as its kind, and the preview names its owner.
          const owned = !named.code && named.owner && named.label !== named.kind;
          return { ref: result.path, kind: "text", label: match.text, kindLabel: named.kind, code: Boolean(named.code), detail: match.text, line: match.line, find: query(), preview: { kind: named.kind, title: owned ? named.owner : named.label } };
        }));
        textState = "done";
        render({ keep: true });
      }, TEXT_SEARCH_DELAY_MS);
    }
    render({ keep: false });
  }

  const all = () => [...matches, ...textMatches];

  function option(entry, index) {
    const code = entry.kind === "file" || entry.code;
    const item = node("prism-list-item", code ? "palette-result is-code" : "palette-result");
    item.setAttribute("value", String(index));
    // A repository file found by its text keeps its path, as the Files group does.
    if (entry.code && entry.kind !== "file") item.dataset.codeSubject = "";
    item.append(icon(entry.kind === "place" ? PLACE_ICONS[entry.ref] ?? "roadmap" : KIND_ICONS[entry.kind] ?? "document", "icon"));
    if (entry.kind === "text") {
      // A line of a document's text is quoted as it is.
      const quoted = node("span", "palette-quote");
      quoted.dataset.codeSubject = "";
      quoted.append(...highlighted(entry.label, tokens()));
      item.append(quoted);
    } else item.append(...highlighted(entry.label, tokens()));
    const claim = entry.kind === "slice" ? claimFor(entry.ref) : null;
    // The holder's name stays in the row's text, so a reader of the list hears who holds the slice.
    const detail = [detailOf(entry), claim ? claim.label : ""].filter(Boolean).join(" · ");
    if (detail) {
      const line = node("span", "palette-detail", detail);
      line.slot = "detail";
      // A file's path is quoted as it is.
      if (entry.kind === "file") line.dataset.codeSubject = "";
      item.append(line);
    }
    if (entry.kind === "record" && entry.detail) {
      const owner = node("span", "palette-detail", entry.detail);
      owner.slot = "detail";
      owner.setAttribute("aria-hidden", "true");
      item.append(owner);
    }
    const meta = node("span", "palette-meta");
    meta.slot = "meta";
    if (claim) meta.append(claimElement(claim, "avatar"));
    meta.append(node("span", "palette-kind", entry.kind === "text" ? "Text" : kindOf(entry)));
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

  function render({ keep }) {
    const active = keep ? results.active?.getAttribute("value") ?? null : null;
    const list = all();
    const key = JSON.stringify([scope.value, list.map((entry) => [entry.ref, entry.kind, entry.label, entry.line ?? null]), textState]);
    if (key === rendered) return;
    rendered = key;
    const groups = [];
    // Results keep their index in `all()` as their value, whichever group shows them.
    const indexed = list.map((entry, index) => ({ entry, index }));
    for (const name of GROUP_ORDER) {
      if (name === "text") {
        if (textState === "searching") groups.push(node("p", "palette-status", "Searching text…"));
        else if (textMatches.length) groups.push(group("text", indexed.filter(({ entry }) => entry.kind === "text").map(({ entry, index }) => option(entry, index))));
        continue;
      }
      const items = indexed.filter(({ entry }) => entry.kind !== "text" && (GROUP_OF[entry.kind] ?? entry.kind) === name);
      if (items.length) groups.push(group(name, items.map(({ entry, index }) => option(entry, index))));
    }
    if (textState === "done" && !list.length) groups.push(node("p", "palette-status", "No text matches."));
    if (!list.length && textState !== "searching" && textState !== "done") groups.push(node("p", "palette-status", "Nothing matches."));
    if (total > matches.length) groups.push(node("p", "palette-status", `${total - matches.length} more ${total - matches.length === 1 ? "result" : "results"}; type more to narrow them`));
    results.replaceChildren(...groups);
    results.activate(active);
    if (count) {
      const shown = list.length;
      const known = total + textMatches.length;
      count.textContent = shown === known ? `${shown} ${shown === 1 ? "result" : "results"}` : `${shown} of ${known}`;
    }
    showPreview();
  }

  // Until an arrow key picks a result, the first one stands in for it: the listbox shows it as current, the preview shows it, and Enter opens it.
  // The listbox keeps no active option then, and the first ArrowDown moves on to the second result.
  const current = () => results.active ?? results.options[0] ?? null;

  function facts(pairs) {
    const list = node("dl", "palette-facts");
    for (const [term, value] of pairs) {
      if (!value) continue;
      list.append(node("dt", "", term), node("dd", "", value));
    }
    return list.childElementCount ? list : null;
  }

  function showPreview() {
    const entry = all()[Number(current()?.getAttribute("value"))];
    if (!entry) {
      preview.replaceChildren(node("p", "palette-preview-hint", "ArrowDown and ArrowUp move through the results, and Enter opens one."));
      return;
    }
    const code = entry.kind === "file" || entry.code;
    const title = node("h3", "palette-preview-title", entry.kind === "text" ? entry.preview?.title ?? entry.label : entry.preview?.title ?? entry.label);
    if (code) title.dataset.codeSubject = "";
    const parts = [node("p", "palette-preview-kind", entry.preview?.kind ?? kindOf(entry)), title];
    if (entry.detail && entry.detail !== entry.preview?.title) {
      const detail = node("p", "palette-preview-detail", entry.kind === "text" ? `Line ${entry.line}: ${entry.detail}` : words(entry.detail));
      // A file's path, and a line of a document's text, are quoted as they are.
      if (code || entry.kind === "text") detail.dataset.codeSubject = "";
      parts.push(detail);
    }
    const claim = entry.kind === "slice" ? claimFor(entry.ref) : null;
    if (claim) parts.push(claimElement(claim, "inline"));
    const [owner, state] = String(entry.detail ?? "").split(" · ");
    const known = entry.kind === "slice" ? facts([["Initiative", owner], ["State", words(state)], ["Claim", claim ? `${claim.label}, ${claim.activity}` : "None"]])
      : entry.kind === "initiative" ? facts([["Band", owner], ["State", words(state)]])
      : entry.kind === "requirement" || entry.kind === "decision" ? facts([["Kind", kindOf(entry)], ["Status", entry.detail]])
      : entry.kind === "record" ? facts([["Kind", entry.kindLabel], ["Belongs to", entry.preview?.title ?? null]])
      : null;
    if (known) parts.push(known);
    preview.replaceChildren(...parts);
  }

  function choose(index, { keep = false } = {}) {
    const entry = all()[index];
    if (!entry) return;
    hide();
    // An action entry of the shown page moves focus to that action's control instead of opening anything.
    if (entry.run) entry.run();
    else onOpen(entry.ref, { find: entry.find ?? null, ...(keep ? { keep: true } : {}) });
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
    } else if (event.key === "Enter" && !event.isComposing && !event.altKey && (event.ctrlKey || event.metaKey) && current()) {
      // Ctrl+Enter or Meta+Enter opens the current result as a kept tab.
      event.preventDefault();
      choose(Number(current().getAttribute("value")), { keep: true });
    } else if (event.key === "Enter" && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !results.active && current()) {
      event.preventDefault();
      results.choose(current());
    }
  });
  // Ctrl-click or Cmd-click on a result opens it as a kept tab, as Ctrl+Enter does.
  let clickKeep = false;
  results.addEventListener("click", (event) => {
    clickKeep = event.ctrlKey || event.metaKey;
  }, { capture: true });
  results.addEventListener("prism-select", (event) => {
    choose(Number(event.detail?.value), { keep: clickKeep });
    clickKeep = false;
  });
  new MutationObserver(showPreview).observe(results, { subtree: true, attributes: true, attributeFilter: ["active"] });
  return { show, hide, isOpen: () => dialog.isOpen };
}
