// Generated from src/server/review/public/views/page-bar.ts by scripts/native-build/compile.mjs.
const ACTION_ICONS = { "Copy link": "copy", "Side panel": "panel", "Details and settings": "more" };
function iconButton(id, label, icon) {
  const button = document.createElement("prism-button");
  if (id) button.id = id;
  button.setAttribute("variant", "ghost");
  button.setAttribute("label", label);
  button.setAttribute("tip", label);
  const glyph = document.createElement("prism-icon");
  glyph.setAttribute("name", icon);
  glyph.setAttribute("size", "sm");
  button.append(glyph);
  return button;
}
function createPageBar({ root, onBack, onForward, onOpen, onPlace = () => {
} }) {
  const history = document.createElement("div");
  history.className = "page-bar-history";
  const back = iconButton("page-back", "Back", "chevron-left");
  const forward = iconButton("page-forward", "Forward", "chevron-right");
  back.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft");
  forward.setAttribute("aria-keyshortcuts", "Alt+ArrowRight");
  back.addEventListener("click", () => onBack());
  forward.addEventListener("click", () => onForward());
  history.append(back, forward);
  const trail = document.createElement("prism-breadcrumbs");
  trail.className = "page-bar-trail";
  trail.setAttribute("current-only", "narrow");
  const actions = document.createElement("div");
  actions.className = "page-bar-actions";
  root.replaceChildren(history, trail, actions);
  let shown = "";
  function setHistory({ back: canBack, forward: canForward }) {
    back.toggleAttribute("disabled", !canBack);
    forward.toggleAttribute("disabled", !canForward);
  }
  function placeAddress(current, place) {
    const query = new URLSearchParams();
    if (current) query.set("artifact", current);
    query.set("place", place);
    return `./review?${query}`;
  }
  function setTrail(crumbs, current = null) {
    const key = JSON.stringify([crumbs, current]);
    if (key === shown) return;
    shown = key;
    trail.replaceChildren(...crumbs.map((crumb) => {
      const link = document.createElement("a");
      link.textContent = crumb.label;
      if (crumb.place) {
        link.href = placeAddress(current, crumb.place);
        link.dataset.place = crumb.place;
        link.addEventListener("click", (event) => {
          if (event.shiftKey || event.ctrlKey || event.metaKey || event.button !== 0) return;
          event.preventDefault();
          onPlace(crumb.place);
        });
      } else if (crumb.ref) {
        link.href = `./review?artifact=${encodeURIComponent(crumb.ref)}`;
        link.addEventListener("click", (event) => {
          if (event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          onOpen(crumb.ref, event);
        });
      }
      if (crumb.code) link.dataset.codeSubject = "";
      return link;
    }));
  }
  function asIcon(action) {
    const name = action.tagName === "PRISM-BUTTON" && !action.hasAttribute("label") ? action.textContent.trim() : "";
    const glyph = ACTION_ICONS[name];
    if (!glyph) return action;
    action.setAttribute("label", name);
    action.setAttribute("tip", name);
    action.removeAttribute("size");
    const symbol = document.createElement("prism-icon");
    symbol.setAttribute("name", glyph);
    symbol.setAttribute("size", "sm");
    action.replaceChildren(symbol);
    return action;
  }
  let focusAfterClear = -1;
  function setActions(nodes) {
    let focused = [...actions.children].findIndex((action) => action.contains(document.activeElement));
    if (focused < 0 && focusAfterClear >= 0 && (!document.activeElement || document.activeElement === document.body)) focused = focusAfterClear;
    focusAfterClear = nodes.length === 0 ? focused : -1;
    actions.replaceChildren(...nodes.map(asIcon));
    actions.hidden = nodes.length === 0;
    if (focused >= 0 && nodes.length) actions.children[focused]?.focus?.({ preventScroll: true });
  }
  setActions([]);
  return { setHistory, setTrail, setActions };
}
export {
  createPageBar
};
