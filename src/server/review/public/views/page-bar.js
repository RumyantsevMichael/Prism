// The page bar at the top of the main island: Back and Forward through the pages visited in this browser tab, the trail of the page's place,
// initiative, and slice by title, and the page's own actions at its end.

function iconButton(id, label, icon) {
  const button = document.createElement("prism-button");
  button.id = id;
  button.setAttribute("variant", "ghost");
  button.setAttribute("size", "sm");
  button.setAttribute("label", label);
  button.setAttribute("tip", label);
  const glyph = document.createElement("prism-icon");
  glyph.setAttribute("name", icon);
  button.append(glyph);
  return button;
}

/**
 * Builds the bar inside `root`. `onBack` and `onForward` move through the history; `onOpen(ref, event)` opens a crumb's page.
 * Returns setHistory({ back, forward }), setTrail([{ ref, label }]), and setActions([nodes]).
 */
export function createPageBar({ root, onBack, onForward, onOpen }) {
  const history = document.createElement("div");
  history.className = "page-bar-history";
  const back = iconButton("page-back", "Back", "back");
  const forward = iconButton("page-forward", "Forward", "forward");
  back.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft");
  forward.setAttribute("aria-keyshortcuts", "Alt+ArrowRight");
  back.addEventListener("click", () => onBack());
  forward.addEventListener("click", () => onForward());
  history.append(back, forward);
  const trail = document.createElement("prism-breadcrumbs");
  trail.className = "page-bar-trail";
  const actions = document.createElement("div");
  actions.className = "page-bar-actions";
  root.replaceChildren(history, trail, actions);
  let shown = "";

  function setHistory({ back: canBack, forward: canForward }) {
    back.toggleAttribute("disabled", !canBack);
    forward.toggleAttribute("disabled", !canForward);
  }

  function setTrail(crumbs) {
    const key = JSON.stringify(crumbs);
    if (key === shown) return;
    shown = key;
    trail.replaceChildren(...crumbs.map((crumb) => {
      const link = document.createElement("a");
      link.textContent = crumb.label;
      if (crumb.ref) {
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

  function setActions(nodes) {
    actions.replaceChildren(...nodes);
    actions.hidden = nodes.length === 0;
  }

  setActions([]);
  return { setHistory, setTrail, setActions };
}
