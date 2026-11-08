// prism-tooltip: the one glass tooltip of a page. It shows the full text of a kit element whose text is shortened, or the element's `tip`,
// after --prism-tooltip-delay of hover and at once on keyboard focus, and hides on pointer leave, blur, or Escape.
import { Base, deepActiveElement, setAttribute, shadow } from "./base.js";

const TOOLTIP_ID = "prism-kit-tooltip";

// The kit element an event concerns: the nearest prism-* element on its path that has a tip or shortened text.
function subjectOf(event) {
  for (const node of event.composedPath()) {
    if (node.nodeType !== 1) continue;
    if (node.tagName === "PRISM-TOOLTIP") return null;
    if (node.tagName.startsWith("PRISM-") && (node.hasAttribute("tip") || node.hasAttribute("shortened"))) return node;
  }
  return null;
}

function fullText(element) {
  const tip = element.getAttribute("tip");
  if (tip) return tip;
  return (element.getAttribute("label") && !element.textContent.trim() ? element.getAttribute("label") : element.textContent).replace(/\s+/g, " ").trim();
}

function delay(element) {
  const value = getComputedStyle(element).getPropertyValue("--prism-tooltip-delay").trim();
  const number = parseFloat(value);
  if (!Number.isFinite(number)) return 0;
  return value.endsWith("ms") ? number : number * 1000;
}

export class PrismTooltip extends Base {
  static tag = "prism-tooltip";
  static styles = ["prism-tooltip.css"];
  static catalog = {
    purpose: "The page's one tooltip: it shows the full text of a shortened kit element, or an element's tip, on frosted glass.",
    options: [
      { name: "tip", values: ["text"], default: "", description: "Set on any kit element: the text the tooltip shows for it." },
      { name: "shortened", values: ["boolean"], default: "false", description: "Set by the kit on an element whose one line of text ends with an ellipsis; the tooltip then shows the full text." }
    ],
    states: ["tip", "shortened"],
    keyboard: ["Keyboard focus on an element with a tip or shortened text shows the tooltip at once.", "Escape hides the tooltip; blur and pointer leave hide it too."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismTooltip.styles, `<div class="surface" part="surface"><slot></slot></div>`);
  }

  connectedCallback() {
    setAttribute(this, "role", "tooltip");
    setAttribute(this, "popover", "manual");
    if (!this.id) this.id = TOOLTIP_ID;
  }

  /** Shows `text` for `target`, which then names the tooltip through aria-describedby. */
  showFor(target, text) {
    if (this.target && this.target !== target) this.release();
    this.target = target;
    this.textContent = text;
    const described = (target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    if (!described.includes(this.id)) {
      target.setAttribute("aria-describedby", [...described, this.id].join(" "));
      this.added = true;
    }
    try {
      if (!this.matches(":popover-open")) this.showPopover();
    } catch {
      return;
    }
    this.place();
  }

  hide() {
    this.release();
    try {
      if (this.matches(":popover-open")) this.hidePopover();
    } catch {
      // A tooltip that left the document is already hidden.
    }
  }

  release() {
    const target = this.target;
    this.target = null;
    if (target && this.added) {
      const described = (target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== this.id);
      if (described.length) target.setAttribute("aria-describedby", described.join(" "));
      else target.removeAttribute("aria-describedby");
    }
    this.added = false;
  }

  // Below the element when there is room, above it otherwise, inside the window.
  place() {
    if (!this.target) return;
    const anchor = this.target.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(this).getPropertyValue("--prism-space-2")) || 0;
    const margin = parseFloat(getComputedStyle(this).getPropertyValue("--prism-space-3")) || 0;
    const box = this.getBoundingClientRect();
    const below = anchor.bottom + gap + box.height <= globalThis.innerHeight - margin;
    const top = below ? anchor.bottom + gap : anchor.top - gap - box.height;
    const left = Math.min(Math.max(margin, anchor.left), Math.max(margin, globalThis.innerWidth - margin - box.width));
    this.style.setProperty("top", `${Math.max(margin, top)}px`);
    this.style.setProperty("left", `${left}px`);
  }
}

/** Adds the page's one tooltip, once, and shows it for the kit elements under the pointer or keyboard focus. */
export function installTooltip(document = globalThis.document) {
  if (!document || document.prismTooltip) return document?.prismTooltip ?? null;
  const tooltip = document.createElement("prism-tooltip");
  document.prismTooltip = tooltip;
  const attach = () => document.body.append(tooltip);
  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach, { once: true });

  let hovered = null;
  let timer = null;
  let byFocus = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  document.addEventListener("pointerover", (event) => {
    const subject = subjectOf(event);
    if (subject === hovered) return;
    hovered = subject;
    cancel();
    if (!subject) {
      if (!byFocus) tooltip.hide();
      return;
    }
    timer = setTimeout(() => {
      if (hovered === subject && subject.isConnected) {
        byFocus = false;
        tooltip.showFor(subject, fullText(subject));
      }
    }, delay(subject));
  });
  document.documentElement.addEventListener("pointerleave", () => {
    hovered = null;
    cancel();
    if (!byFocus) tooltip.hide();
  });
  document.addEventListener("focusin", (event) => {
    const subject = subjectOf(event);
    cancel();
    if (!subject) {
      if (byFocus) tooltip.hide();
      byFocus = false;
      return;
    }
    const focused = deepActiveElement(document);
    if (focused?.matches?.(":focus-visible")) {
      byFocus = true;
      tooltip.showFor(subject, fullText(subject));
    }
  });
  document.addEventListener("focusout", (event) => {
    if (byFocus && subjectOf(event) === tooltip.target) {
      byFocus = false;
      tooltip.hide();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && tooltip.target) {
      byFocus = false;
      cancel();
      tooltip.hide();
    }
  }, true);
  globalThis.addEventListener("scroll", () => tooltip.place(), true);
  return tooltip;
}
