// prism-dialog: a modal dialog on frosted glass over a native <dialog>, whose backdrop is the blurred scrim. It renders in light DOM:
// its heading and a Close button sit in its header, children with slot="footer" after its body, and every other child in its body.
import { Base, deepActiveElement, distribute, emit, focusables, make, setAttribute, uniqueId } from "./base.js";

const PLACEMENTS = ["center", "start", "bottom"];
const SIZES = ["sm", "md", "lg"];

export class PrismDialog extends Base {
  static tag = "prism-dialog";
  static observedAttributes = ["heading", "open", "size", "placement"];
  static catalog = {
    purpose: "A modal dialog on frosted glass over a blurred scrim, which keeps focus inside it and returns focus where it was when it closes; it can also open as a drawer from the left edge or a sheet from the bottom.",
    options: [
      { name: "heading", values: ["text"], default: "", description: "The heading, which names the dialog." },
      { name: "open", values: ["boolean"], default: "false", description: "Whether the dialog shows; show() and close() set it." },
      { name: "size", values: SIZES, default: "md", description: "The width of a centered dialog." },
      { name: "placement", values: PLACEMENTS, default: "center", description: "center floats in the window, start slides in from the left edge at --prism-drawer-width, and bottom rises from the bottom edge at full width." },
      { name: "slot=\"footer\"", values: ["children"], default: "", description: "Actions after the body." }
    ],
    states: ["closed", "center", "start", "bottom", "long-content"],
    keyboard: [
      "Focus moves into the dialog when it opens, and Tab and Shift+Tab stay inside it.",
      "Escape, the Close button, or a click on the scrim closes it and sends prism-close; focus returns to the element that had it."
    ]
  };

  connectedCallback() {
    if (!this.surface) this.build();
    this.sync();
    if (this.hasAttribute("open") && !this.surface.open) this.show();
  }

  disconnectedCallback() {
    if (this.surface?.open) this.surface.close();
  }

  attributeChangedCallback(name) {
    if (!this.surface) return;
    if (name === "open" && !this.changing) {
      if (this.hasAttribute("open")) this.show();
      else this.close();
      return;
    }
    this.sync();
  }

  build() {
    const id = uniqueId("prism-dialog");
    this.surface = make(this, "dialog", "prism-dialog-surface", { role: "dialog", "aria-modal": "true", "aria-labelledby": `${id}-heading` });
    const head = make(this, "header", "prism-dialog-head");
    this.headingElement = make(this, "h2", "prism-dialog-heading", { id: `${id}-heading` });
    this.closeButton = make(this, "prism-button", "prism-dialog-close", { variant: "ghost", size: "sm", label: "Close" });
    this.closeButton.append(make(this, "prism-icon", "", { name: "close" }));
    this.closeButton.addEventListener("click", () => this.close());
    head.append(this.headingElement, this.closeButton);
    this.body = make(this, "div", "prism-dialog-body");
    this.footer = make(this, "footer", "prism-dialog-foot");
    this.surface.append(head, this.body, this.footer);
    this.append(this.surface);
    this.children$ = distribute(this, { footer: this.footer, default: this.body }, [this.surface]);
    this.surface.addEventListener("close", () => this.closed());
    this.surface.addEventListener("keydown", (event) => this.trap(event));
    // A click whose point is outside the surface lands on its backdrop, the scrim.
    this.surface.addEventListener("click", (event) => {
      if (event.target !== this.surface) return;
      const box = this.surface.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) this.close();
    });
  }

  sync() {
    this.headingElement.textContent = this.getAttribute("heading") ?? "";
    if (!PLACEMENTS.includes(this.getAttribute("placement"))) setAttribute(this.surface, "data-placement", "center");
    else setAttribute(this.surface, "data-placement", this.getAttribute("placement"));
    setAttribute(this.surface, "data-size", SIZES.includes(this.getAttribute("size")) ? this.getAttribute("size") : "md");
    this.footer.hidden = this.footer.childNodes.length === 0;
  }

  get isOpen() {
    return Boolean(this.surface?.open);
  }

  setOpenAttribute(on) {
    this.changing = true;
    this.toggleAttribute("open", on);
    this.changing = false;
  }

  /** Opens the dialog as a modal, remembering the focused element and moving focus inside. */
  show() {
    if (!this.surface) this.build();
    this.sync();
    if (this.surface.open) return;
    this.returnTo = this.ownerDocument.activeElement;
    this.setOpenAttribute(true);
    try {
      this.surface.showModal();
    } catch {
      this.setOpenAttribute(false);
      return;
    }
    const first = this.surface.querySelector("[autofocus]") ?? focusables(this.body)[0] ?? focusables(this.footer)[0] ?? this.closeButton;
    first.focus();
  }

  /** Closes the dialog; it then sends prism-close and returns focus. */
  close() {
    if (this.surface?.open) this.surface.close();
  }

  closed() {
    this.setOpenAttribute(false);
    const target = this.returnTo;
    this.returnTo = null;
    if (target?.isConnected && target !== this.ownerDocument.body) target.focus?.();
    emit(this, "prism-close", {});
  }

  // Tab and Shift+Tab wrap inside the dialog.
  trap(event) {
    if (event.key !== "Tab") return;
    const stops = focusables(this.surface);
    if (!stops.length) return;
    const active = this.ownerDocument.activeElement;
    const deep = deepActiveElement(this.ownerDocument);
    const index = stops.findIndex((stop) => stop === active || stop === deep || stop.contains(deep));
    const next = event.shiftKey ? (index <= 0 ? stops.at(-1) : null) : (index === stops.length - 1 || index < 0 ? stops[0] : null);
    if (!next) return;
    event.preventDefault();
    next.focus();
  }
}
