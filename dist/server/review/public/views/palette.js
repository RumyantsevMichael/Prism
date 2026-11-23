// Generated from src/server/review/public/views/palette.ts by scripts/native-build/compile.mjs.
import { claimElement } from "./claim-index.js";
import { formatBadgeElement } from "./format-marks.js";
const KIND_ORDER = ["action", "place", "slice", "initiative", "requirement", "decision", "record", "term", "file", "code"];
const GROUP_OF = { requirement: "document", decision: "document", record: "document" };
const GROUPS = { action: "Settings on this page", place: "Places", initiative: "Initiatives", slice: "Slices", document: "Documents", term: "Glossary terms", file: "Files", text: "Text matches", code: "Code in indexed components" };
const GROUP_ORDER = ["action", "place", "slice", "initiative", "document", "term", "text", "code", "file"];
const LEFT_OUT = { no_checkout: "no checkout here", no_index: "no ready index", search_failed: "search failed" };
const KINDS = { action: "Setting", place: "Place", initiative: "Initiative", slice: "Slice", requirement: "Requirement", decision: "Decision", term: "Term", file: "File", code: "Code" };
const SCOPES = [
  { value: "all", label: "All", kinds: null },
  { value: "slices", label: "Slices", kinds: ["slice"] },
  { value: "initiatives", label: "Initiatives", kinds: ["initiative"] },
  { value: "documents", label: "Documents", kinds: ["requirement", "decision", "record", "term"] },
  { value: "files", label: "Files", kinds: ["file"] },
  { value: "text", label: "Text", kinds: ["text", "code"] }
];
const PLACE_ICONS = { attention: "bell", roadmap: "roadmap", requirements: "list", decisions: "scale", glossary: "book", agents: "agent", code: "code" };
const KIND_ICONS = { action: "filter", initiative: "roadmap", slice: "layers", requirement: "list", decision: "scale", term: "book", record: "document", file: "code", text: "document", code: "code" };
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
  if (text !== void 0) element.textContent = text;
  return element;
}
function icon(name, slot) {
  const glyph = document.createElement("prism-icon");
  glyph.setAttribute("name", name);
  glyph.setAttribute("size", "sm");
  if (slot) glyph.slot = slot;
  return glyph;
}
function kindOf(entry) {
  return entry.kindLabel ?? KINDS[entry.kind] ?? entry.kind;
}
function highlighted(text, tokens) {
  const words2 = [...new Set(tokens.filter(Boolean))].sort((left, right) => right.length - left.length);
  if (!words2.length) return [document.createTextNode(text)];
  const lower = text.toLowerCase();
  const parts = [];
  let at = 0;
  while (at < text.length) {
    let found = -1;
    let word = "";
    for (const candidate of words2) {
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
const words = (text) => String(text ?? "").replace(/-/g, " ");
function detailOf(entry) {
  if (entry.kind === "text") return [entry.kindLabel, entry.line ? `Line ${entry.line}` : ""].filter(Boolean).join(" \xB7 ");
  if (entry.kind === "code") return entry.line ? `Line ${entry.line}` : "";
  if (entry.kind === "requirement" || entry.kind === "decision") return [kindOf(entry), entry.detail].filter(Boolean).join(" \xB7 ");
  if (entry.kind === "record") return "";
  return words(entry.detail);
}
function createPalette({ dialog, field, results, preview, scopes = null, count = null, entries, onOpen, search = null, describe = (path) => ({ label: path, kind: "Document" }), claimFor = () => null }) {
  let matches = [];
  let total = 0;
  let textMatches = [];
  let codeMatches = [];
  let leftOut = [];
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
    const words2 = tokens();
    const all2 = entries().filter((entry) => kept(entry.kind));
    const found = text ? all2.map((entry) => ({ entry, rank: rank(entry, text, words2) })).filter((item) => item.rank).sort(compare).map((item) => item.entry) : all2.filter((entry) => scope.kinds || entry.kind === "action" || entry.kind === "place" || entry.kind === "initiative");
    total = found.length;
    matches = found.slice(0, RESULT_LIMIT);
    textMatches = [];
    codeMatches = [];
    leftOut = [];
    clearTimeout(searchTimer);
    const current2 = ++searchRequest;
    textState = search && kept("text") && text.length >= TEXT_SEARCH_MINIMUM ? "searching" : "idle";
    if (textState === "searching") {
      searchTimer = setTimeout(async () => {
        let answer = [];
        try {
          answer = await search(query());
        } catch {
          answer = [];
        }
        if (current2 !== searchRequest) return;
        const found2 = Array.isArray(answer) ? answer : answer.results ?? [];
        codeMatches = Array.isArray(answer) ? [] : (answer.code ?? []).map((match) => ({ ref: match.ref, kind: "code", label: match.file, code: true, detail: String(match.excerpt ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? "", line: match.range?.startLine ?? null, find: null, scope: match.component }));
        leftOut = Array.isArray(answer) ? [] : answer.leftOut ?? [];
        textMatches = found2.flatMap((result) => result.matches.slice(0, 1).map((match) => {
          const named = describe(result.path);
          const owned = !named.code && named.owner && named.label !== named.kind;
          return { ref: result.path, kind: "text", label: match.text, kindLabel: named.kind, code: Boolean(named.code), detail: match.text, line: match.line, find: query(), scope: result.scope ?? null, preview: { kind: named.kind, title: owned ? named.owner : named.label } };
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
    if (entry.code && entry.kind !== "file") item.dataset.codeSubject = "";
    item.append(icon(entry.kind === "place" ? PLACE_ICONS[entry.ref] ?? "roadmap" : KIND_ICONS[entry.kind] ?? "document", "icon"));
    if (entry.kind === "text") {
      const quoted = node("span", "palette-quote");
      quoted.dataset.codeSubject = "";
      quoted.append(...highlighted(entry.label, tokens()));
      item.append(quoted);
    } else item.append(...highlighted(entry.label, tokens()));
    const claim = entry.kind === "slice" ? claimFor(entry.ref) : null;
    const detail = [detailOf(entry), claim ? claim.label : ""].filter(Boolean).join(" \xB7 ");
    const mark = entry.kind === "requirement" || entry.kind === "decision" ? formatBadgeElement(entry.format) : null;
    if (detail || mark) {
      const line = node("span", "palette-detail", detail);
      if (mark) line.prepend(mark, " ");
      line.slot = "detail";
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
    if (entry.scope) {
      const scope2 = node("prism-chip", "", entry.scope);
      scope2.dataset.scopeLabel = "";
      meta.append(scope2, " ");
    }
    meta.append(node("span", "palette-kind", entry.kind === "text" ? "Text" : kindOf(entry)));
    item.append(meta);
    return item;
  }
  function group(kind, items, label = GROUPS[kind] ?? kind) {
    const holder = node("div", "palette-group");
    holder.setAttribute("role", "group");
    holder.setAttribute("aria-label", label);
    if (kind === "file") holder.dataset.codeSubject = "";
    holder.append(node("div", "palette-group-label", label), ...items);
    return holder;
  }
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
    const key = JSON.stringify([scope.value, list.map((entry) => [entry.ref, entry.kind, entry.label, entry.line ?? null]), leftOut, textState]);
    if (key === rendered) return;
    rendered = key;
    const groups = [];
    const indexed = list.map((entry, index) => ({ entry, index }));
    for (const name of GROUP_ORDER) {
      if (name === "text") {
        if (textState === "searching") groups.push(node("p", "palette-status", "Searching text\u2026"));
        else if (textMatches.length) groups.push(group("text", indexed.filter(({ entry }) => entry.kind === "text").map(({ entry, index }) => option(entry, index))));
        continue;
      }
      const items = indexed.filter(({ entry }) => entry.kind !== "text" && (GROUP_OF[entry.kind] ?? entry.kind) === name);
      if (items.length) groups.push(group(name, items.map(({ entry, index }) => option(entry, index))));
    }
    if (textState === "done" && !list.length) groups.push(node("p", "palette-status", "No text matches."));
    if (textState === "done" && leftOut.length) groups.push(leftOutGroup());
    if (!list.length && textState !== "searching" && textState !== "done") groups.push(node("p", "palette-status", "Nothing matches."));
    if (total > matches.length) groups.push(node("p", "palette-status", `${total - matches.length} more ${total - matches.length === 1 ? "result" : "results"}; type more to narrow them`));
    results.replaceChildren(...groups);
    results.activate(active);
    if (count) {
      const shown = list.length;
      const known = total + textMatches.length + codeMatches.length;
      count.textContent = shown === known ? `${shown} ${shown === 1 ? "result" : "results"}` : `${shown} of ${known}`;
    }
    showPreview();
  }
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
      const detail = node("p", "palette-preview-detail", entry.kind === "text" || entry.kind === "code" ? entry.line ? `Line ${entry.line}: ${entry.detail}` : entry.detail : words(entry.detail));
      if (code || entry.kind === "text") detail.dataset.codeSubject = "";
      parts.push(detail);
    }
    const claim = entry.kind === "slice" ? claimFor(entry.ref) : null;
    if (claim) parts.push(claimElement(claim, "inline"));
    const [owner, state] = String(entry.detail ?? "").split(" \xB7 ");
    const known = entry.kind === "slice" ? facts([["Initiative", owner], ["State", words(state)], ["Claim", claim ? `${claim.label}, ${claim.activity}` : "None"]]) : entry.kind === "initiative" ? facts([["Band", owner], ["State", words(state)]]) : entry.kind === "requirement" || entry.kind === "decision" ? facts([["Kind", kindOf(entry)], ["Status", entry.detail]]) : entry.kind === "record" ? facts([["Kind", entry.kindLabel], ["Belongs to", entry.preview?.title ?? null]]) : null;
    if (known) parts.push(known);
    preview.replaceChildren(...parts);
  }
  function choose(index, { keep = false } = {}) {
    const entry = all()[index];
    if (!entry) return;
    hide();
    if (entry.run) entry.run();
    else onOpen(entry.ref, { find: entry.find ?? null, ...keep ? { keep: true } : {} });
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
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hide();
    } else if (event.key === "Enter" && !event.isComposing && !event.altKey && (event.ctrlKey || event.metaKey) && current()) {
      event.preventDefault();
      choose(Number(current().getAttribute("value")), { keep: true });
    } else if (event.key === "Enter" && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !results.active && current()) {
      event.preventDefault();
      results.choose(current());
    }
  });
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
export {
  createPalette,
  highlighted,
  kindOf
};
