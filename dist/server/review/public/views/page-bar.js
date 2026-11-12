// The page bar at the top of the main island: Back and Forward through the pages visited in this browser tab, the trail of the page's place,
// initiative, and slice by title, and the page's own actions at its end.
// Every control of the bar is an icon button at the control height; an action the bar knows by name, such as Copy link, takes its icon and keeps its name as its label.

// The glyph of each page action the bar draws as an icon; any other action keeps its text.
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

/**
 * Builds the bar inside `root`. `onBack` and `onForward` move through the history; `onOpen(ref, event)` opens a crumb's page,
 * and `onPlace(name)` makes the place of the trail's first crumb current.
 * Returns setHistory({ back, forward }), setTrail([{ ref, label, place }], current), and setActions([nodes]).
 */
export function createPageBar({ root, onBack, onForward, onOpen, onPlace = () => {} }) {
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
  // In a phone-width window the bar reads Back, Forward, then the page alone.
  trail.setAttribute("current-only", "narrow");
  const actions = document.createElement("div");
  actions.className = "page-bar-actions";
  root.replaceChildren(history, trail, actions);
  let shown = "";

  function setHistory({ back: canBack, forward: canForward }) {
    back.toggleAttribute("disabled", !canBack);
    forward.toggleAttribute("disabled", !canForward);
  }

  // The address of the open page with a place chosen, which the place's crumb links to.
  function placeAddress(current, place) {
    const query = new URLSearchParams();
    if (current) query.set("artifact", current);
    query.set("place", place);
    return `./review?${query}`;
  }

  // A crumb that carries a place names it and chooses it without leaving the page; a Shift click or a middle-click opens the page with that place in the browser.
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
          // A Shift click or a middle-click is the browser's: it opens the crumb in a new window or browser tab; a Ctrl or Cmd click keeps a review tab.
          if (event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          onOpen(crumb.ref, event);
        });
      }
      if (crumb.code) link.dataset.codeSubject = "";
      return link;
    }));
  }

  // A text action the bar knows becomes an icon button of the same name; its clicks, pressed state, and disabled state stay its own.
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

  function setActions(nodes) {
    actions.replaceChildren(...nodes.map(asIcon));
    actions.hidden = nodes.length === 0;
  }

  setActions([]);
  return { setHistory, setTrail, setActions };
}
