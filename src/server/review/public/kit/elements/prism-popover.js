// prism-popover: a non-modal dialog on frosted glass that the kit button named by `for` opens, anchored to that button and kept inside the window,
// spanning the window's width at 720px and below. It renders in light DOM: its heading first, then every child in its body.
import { Base, deepActiveElement, distribute, emit, focusables, make, setAttribute, uniqueId } from "./base.js";

const open = new Set();
const NARROW = "(max-width: 720px)";

function pixels(element, name) {
  return parseFloat(getComputedStyle(element).getPropertyValue(name)) || 0;
}

export class PrismPopover extends Base {
  static tag = "prism-popover";
  static observedAttributes = ["for", "heading", "open"];
  static catalog = {
    purpose: "A non-modal panel on frosted glass that a kit button opens, such as Who's working; it stays inside the window and spans its width on narrow windows.",
    options: [
      { name: "for", values: ["id"], default: "", description: "The id of the kit button that opens it; the popover sets aria-haspopup=\"dialog\" and aria-expanded on it." },
      { name: "heading", values: ["text"], default: "", description: "The heading, which names the popover." },
      { name: "open", values: ["boolean"], default: "false", description: "Whether the popover shows." }
    ],
    states: ["closed", "open", "long-content"],
    keyboard: [
      "Enter, Space, or a click on its button toggles the popover, and focus moves into it when it opens.",
      "Escape closes it and returns focus to its button; a click outside or focus leaving it closes it."
    ]
  };

  constructor() {
    super();
    this.onTriggerClick = () => (this.isOpen ? this.close({ focus: true }) : this.show());
    this.onOutside = (event) => {
      const path = event.composedPath();
      if (path.includes(this) || (this.trigger && path.includes(this.trigger))) return;
      this.close();
    };
    this.onViewport = () => this.place();
    this.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.isOpen) {
        event.preventDefault();
        event.stopPropagation();
        this.close({ focus: true });
      }
    });
    this.addEventListener("focusout", (event) => {
      const next = event.relatedTarget;
      if (!this.isOpen || !next) return;
      if (this.contains(next) || (this.trigger && (next === this.trigger || this.trigger.contains(next)))) return;
      this.close();
    });
  }

  connectedCallback() {
    if (!this.body) this.build();
    setAttribute(this, "role", "dialog");
    setAttribute(this, "popover", "manual");
    setAttribute(this, "tabindex", "-1");
    this.sync();
    this.bind();
    if (!this.trigger && this.hasAttribute("for")) requestAnimationFrame(() => this.bind());
  }

  disconnectedCallback() {
    this.unbind();
    this.stopListening();
    open.delete(this);
  }

  attributeChangedCallback(name) {
    if (!this.body) return;
    if (name === "for") this.bind();
    else if (name === "open" && !this.changing) {
      if (this.hasAttribute("open")) this.show({ focus: false });
      else this.close();
    } else this.sync();
  }

  build() {
    const id = uniqueId("prism-popover");
    this.headingElement = make(this, "h2", "prism-popover-heading", { id: `${id}-heading` });
    this.body = make(this, "div", "prism-popover-body");
    this.prepend(this.headingElement);
    this.append(this.body);
    setAttribute(this, "aria-labelledby", this.headingElement.id);
    this.children$ = distribute(this, { default: this.body }, [this.headingElement, this.body]);
  }

  sync() {
    const heading = this.getAttribute("heading") ?? "";
    this.headingElement.textContent = heading;
    this.headingElement.hidden = !heading;
  }

  get isOpen() {
    return this.matches(":popover-open");
  }

  bind() {
    const id = this.getAttribute("for");
    const trigger = id ? this.getRootNode().getElementById?.(id) ?? this.ownerDocument.getElementById(id) : null;
    if (trigger === this.trigger) return;
    this.unbind();
    if (!trigger) return;
    this.trigger = trigger;
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", String(this.isOpen));
    trigger.addEventListener("click", this.onTriggerClick);
    if (this.hasAttribute("open")) this.show({ focus: false });
  }

  unbind() {
    if (!this.trigger) return;
    this.trigger.removeEventListener("click", this.onTriggerClick);
    this.trigger = null;
  }

  setOpenAttribute(on) {
    this.changing = true;
    this.toggleAttribute("open", on);
    this.changing = false;
  }

  /** Opens the popover, closing any other open popover, and moves focus into it unless `focus` is false. */
  show({ focus = true } = {}) {
    for (const other of [...open]) if (other !== this) other.close();
    if (!this.isOpen) {
      try {
        this.showPopover();
      } catch {
        return;
      }
    }
    open.add(this);
    this.setOpenAttribute(true);
    this.trigger?.setAttribute("aria-expanded", "true");
    this.place();
    this.listen();
    if (focus) (focusables(this.body)[0] ?? this).focus();
    emit(this, "prism-open", {});
  }

  /** Closes the popover, returning focus to its button when `focus` is set. */
  close({ focus = false } = {}) {
    const wasOpen = this.isOpen;
    if (wasOpen) {
      try {
        this.hidePopover();
      } catch {
        // A popover that left the document is already hidden.
      }
    }
    open.delete(this);
    this.setOpenAttribute(false);
    this.trigger?.setAttribute("aria-expanded", "false");
    this.stopListening();
    const inside = this.contains(deepActiveElement(this.ownerDocument));
    if (focus || inside) this.trigger?.focus();
    if (wasOpen) emit(this, "prism-close", {});
  }

  listen() {
    if (this.listening) return;
    this.listening = true;
    this.ownerDocument.addEventListener("pointerdown", this.onOutside, true);
    globalThis.addEventListener("resize", this.onViewport);
    globalThis.addEventListener("scroll", this.onViewport, true);
  }

  stopListening() {
    if (!this.listening) return;
    this.listening = false;
    this.ownerDocument.removeEventListener("pointerdown", this.onOutside, true);
    globalThis.removeEventListener("resize", this.onViewport);
    globalThis.removeEventListener("scroll", this.onViewport, true);
  }

  // Below its button, or above it when there is more room there, aligned to the button's end and inside the window; full width when the window is narrow.
  place() {
    if (!this.isOpen) return;
    const narrow = globalThis.matchMedia?.(NARROW).matches ?? false;
    this.toggleAttribute("data-narrow", narrow);
    const anchor = this.trigger?.getBoundingClientRect() ?? { top: 0, bottom: 0, left: 0, right: globalThis.innerWidth };
    const gap = pixels(this, "--prism-space-2");
    const margin = narrow ? 0 : pixels(this, "--prism-space-3");
    this.style.removeProperty("max-height");
    const below = globalThis.innerHeight - anchor.bottom - gap - margin;
    const above = anchor.top - gap - margin;
    let box = this.getBoundingClientRect();
    const downward = box.height <= below || below >= above;
    const room = Math.max(0, downward ? below : above);
    if (box.height > room) this.style.setProperty("max-height", `${room}px`);
    box = this.getBoundingClientRect();
    const top = downward ? anchor.bottom + gap : anchor.top - gap - box.height;
    const left = narrow ? 0 : Math.min(Math.max(margin, anchor.right - box.width), Math.max(margin, globalThis.innerWidth - margin - box.width));
    this.style.setProperty("top", `${Math.max(margin, top)}px`);
    this.style.setProperty("left", `${left}px`);
  }
}
