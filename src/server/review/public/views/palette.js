import { escapeHtml } from "./util.js";

const KIND_ORDER = ["place", "initiative", "slice", "requirement", "decision", "term", "file"];
const RESULT_LIMIT = 40;

function rank(entry, query, tokens) {
  const label = entry.label.toLowerCase();
  const haystack = `${label} ${String(entry.detail ?? "").toLowerCase()} ${entry.ref.toLowerCase()}`;
  if (!tokens.every((token) => haystack.includes(token))) return null;
  const position = label.startsWith(query) ? 0 : label.includes(query) ? 1 : 2;
  return [position, KIND_ORDER.indexOf(entry.kind), label.length];
}

function compare(left, right) {
  for (let index = 0; index < left.rank.length; index += 1) {
    if (left.rank[index] !== right.rank[index]) return left.rank[index] - right.rank[index];
  }
  return 0;
}

const TEXT_SEARCH_DELAY_MS = 200;
const TEXT_SEARCH_MINIMUM = 3;

// A jump list over Prism entities and reviewable files by name, followed by full-text matches in Prism artifacts.
export function createPalette({ dialog, input, results, entries, onOpen, search = null }) {
  let matches = [];
  let textMatches = [];
  let textState = "idle";
  let active = 0;
  let returnFocus = null;
  let searchTimer = 0;
  let searchRequest = 0;

  function update() {
    const query = input.value.trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const all = entries();
    matches = query
      ? all.map((entry) => ({ entry, rank: rank(entry, query, tokens) })).filter((item) => item.rank).sort(compare).slice(0, RESULT_LIMIT).map((item) => item.entry)
      : all.filter((entry) => entry.kind === "place" || entry.kind === "initiative").slice(0, RESULT_LIMIT);
    active = 0;
    textMatches = [];
    clearTimeout(searchTimer);
    const current = ++searchRequest;
    textState = search && query.length >= TEXT_SEARCH_MINIMUM ? "searching" : "idle";
    if (textState === "searching") {
      searchTimer = setTimeout(async () => {
        let found = [];
        try {
          found = await search(input.value.trim());
        } catch {
          found = [];
        }
        if (current !== searchRequest) return;
        textMatches = found.flatMap((result) => result.matches.slice(0, 1).map((match) => ({ ref: result.path, kind: "text", label: result.path.split("/").pop(), detail: `${result.path}:${match.line}  ${match.text}`, find: input.value.trim() })));
        textState = "done";
        render();
      }, TEXT_SEARCH_DELAY_MS);
    }
    render();
  }

  function all() {
    return [...matches, ...textMatches];
  }

  function option(entry, index) {
    return `<li role="option" id="palette-option-${index}" class="palette-option${entry.kind === "text" ? " is-text" : ""}" data-index="${index}" aria-selected="${index === active}">
          <span class="palette-kind kind-${escapeHtml(entry.kind)}">${escapeHtml(entry.kind)}</span>
          <span class="palette-label">${escapeHtml(entry.label)}</span>
          ${entry.detail ? `<span class="palette-detail">${escapeHtml(entry.detail)}</span>` : ""}
        </li>`;
  }

  function render() {
    const textHeader = textState === "searching"
      ? '<li class="palette-section" role="presentation">Searching text…</li>'
      : textState === "done" ? `<li class="palette-section" role="presentation">${textMatches.length ? "Text matches" : "No text matches"}</li>` : "";
    results.innerHTML = matches.length || textState !== "idle"
      ? `${matches.map(option).join("")}${textHeader}${textMatches.map((entry, index) => option(entry, matches.length + index)).join("")}`
      : '<li class="palette-empty">Nothing matches.</li>';
    input.setAttribute("aria-activedescendant", all().length ? `palette-option-${active}` : "");
    results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  function choose(index, keep) {
    const entry = all()[index];
    if (!entry) return;
    hide();
    onOpen(entry.ref, { keep, find: entry.find ?? null });
  }

  function show() {
    returnFocus = document.activeElement;
    dialog.hidden = false;
    input.value = "";
    update();
    input.focus();
  }

  function hide() {
    clearTimeout(searchTimer);
    searchRequest += 1;
    dialog.hidden = true;
    returnFocus?.focus?.();
  }

  input.addEventListener("input", update);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = all().length;
      if (count) active = (active + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
      render();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active, event.ctrlKey || event.metaKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      hide();
    }
  });
  results.addEventListener("click", (event) => {
    const option = event.target.closest("[data-index]");
    if (option) choose(Number(option.dataset.index), event.ctrlKey || event.metaKey);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) hide();
  });
  return { show, hide, isOpen: () => !dialog.hidden };
}
