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

// A name-only jump list over Prism entities and reviewable files; it never searches file contents.
export function createPalette({ dialog, input, results, entries, onOpen }) {
  let matches = [];
  let active = 0;
  let returnFocus = null;

  function update() {
    const query = input.value.trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const all = entries();
    matches = query
      ? all.map((entry) => ({ entry, rank: rank(entry, query, tokens) })).filter((item) => item.rank).sort(compare).slice(0, RESULT_LIMIT).map((item) => item.entry)
      : all.filter((entry) => entry.kind === "place" || entry.kind === "initiative").slice(0, RESULT_LIMIT);
    active = 0;
    render();
  }

  function render() {
    results.innerHTML = matches.length
      ? matches.map((entry, index) => `<li role="option" id="palette-option-${index}" class="palette-option" data-index="${index}" aria-selected="${index === active}">
          <span class="palette-kind kind-${escapeHtml(entry.kind)}">${escapeHtml(entry.kind)}</span>
          <span class="palette-label">${escapeHtml(entry.label)}</span>
          ${entry.detail ? `<span class="palette-detail">${escapeHtml(entry.detail)}</span>` : ""}
        </li>`).join("")
      : '<li class="palette-empty">Nothing matches.</li>';
    input.setAttribute("aria-activedescendant", matches.length ? `palette-option-${active}` : "");
    results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  function choose(index, keep) {
    const entry = matches[index];
    if (!entry) return;
    hide();
    onOpen(entry.ref, { keep });
  }

  function show() {
    returnFocus = document.activeElement;
    dialog.hidden = false;
    input.value = "";
    update();
    input.focus();
  }

  function hide() {
    dialog.hidden = true;
    returnFocus?.focus?.();
  }

  input.addEventListener("input", update);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length) active = (active + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
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
