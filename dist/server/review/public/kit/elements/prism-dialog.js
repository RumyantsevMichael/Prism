// prism-dialog: a modal dialog on frosted glass over a native <dialog>, whose backdrop is the blurred scrim. It renders in light DOM:
// its heading and a Close button sit in its header, children with slot="footer" after its body, and every other child in its body.
import { Base, deepActiveElement, distribute, emit, focusables, make, setAttribute, uniqueId } from "./base.js";

const PLACEMENTS = ["center", "top", "start", "bottom", "end"];
const SIZES = ["sm", "md", "lg"];

export class PrismDialog extends Base {
  static tag = "prism-dialog";
  static observedAttributes = ["heading", "open", "size", "placement", "bare", "modeless"];
  static catalog = {
    purpose: "A modal dialog on frosted glass over a blurred scrim, which keeps focus inside it and returns focus where it was when it closes; it can also open near the top as a command palette does, as a drawer from the left edge, or as a sheet from the bottom.",
    options: [
      { name: "heading", values: ["text"], default: "", description: "The heading, which names the dialog." },
      { name: "open", values: ["boolean"], default: "false", description: "Whether the dialog shows; show() and close() set it." },
      { name: "size", values: SIZES, default: "md", description: "The width of a centered dialog." },
      { name: "placement", values: PLACEMENTS, default: "center", description: "center floats in the window; top hangs below the top bar with the spectrum on its top edge, as a command palette; start opens a drawer at --prism-drawer-width from the left edge, an island between the top bar and the status bar; bottom rises from the bottom edge at full width; and end stands at --prism-panel-width against the right edge between the top bar and the status bar." },
      { name: "modeless", values: ["boolean"], default: "false", description: "Opens without a scrim and leaves the page usable behind it, as a drawer of details beside the page does; Escape and Close still close it, and focus moves into it when it opens." },
      { name: "bare", values: ["boolean"], default: "false", description: "Shows no header: the heading still names the dialog for assistive technology, and Escape or a click on the scrim closes it, for a dialog whose content draws its own header or none." },
      { name: "slot=\"footer\"", values: ["children"], default: "", description: "Actions after the body." }
    ],
    states: ["closed", "center", "top", "start", "bottom", "end", "modeless", "bare", "long-content"],
    keyboard: [
      "Focus moves into the dialog when it opens, and Tab and Shift+Tab stay inside it.",
      "Escape, the Close button, or a click on the scrim closes it and sends prism-close; focus returns to the element that had it; a bare dialog has no Close button."
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
    // The frame holds the dialog's parts; a drawer draws it as an island inset from the surface's edges, and other placements leave it out of the layout.
    this.frame = make(this, "div", "prism-dialog-frame");
    this.frame.append(head, this.body, this.footer);
    this.surface.append(this.frame);
    this.append(this.surface);
    this.children$ = distribute(this, { footer: this.footer, default: this.body }, [this.surface]);
    this.surface.addEventListener("close", () => this.closed());
    this.surface.addEventListener("keydown", (event) => {
      // A modeless dialog is not the browser's modal, so Escape closes it here; Tab moves on to the page as it would from any region.
      if (this.hasAttribute("modeless")) {
        if (event.key === "Escape") {
          event.preventDefault();
          this.close();
        }
        return;
      }
      this.trap(event);
    });
    // A click whose point is outside the surface lands on its backdrop, the scrim.
    this.surface.addEventListener("click", (event) => {
      if (event.target !== this.surface) return;
      const drawn = this.surface.dataset.placement === "start" ? this.frame : this.surface;
      const box = drawn.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) this.close();
    });
  }

  sync() {
    this.headingElement.textContent = this.getAttribute("heading") ?? "";
    if (!PLACEMENTS.includes(this.getAttribute("placement"))) setAttribute(this.surface, "data-placement", "center");
    else setAttribute(this.surface, "data-placement", this.getAttribute("placement"));
    setAttribute(this.surface, "data-size", SIZES.includes(this.getAttribute("size")) ? this.getAttribute("size") : "md");
    const bare = this.hasAttribute("bare");
    setAttribute(this.surface, "data-bare", bare ? "" : null);
    this.closeButton.hidden = bare;
    this.footer.hidden = this.footer.childNodes.length === 0;
    const modeless = this.hasAttribute("modeless");
    setAttribute(this.surface, "aria-modal", modeless ? "false" : "true");
    setAttribute(this.surface, "data-modeless", modeless ? "" : null);
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
    // A surface closed natively, as by Escape, sends its close event a task later; finish that opening before this one starts.
    this.closed();
    this.returnTo = this.ownerDocument.activeElement;
    this.pending = true;
    this.setOpenAttribute(true);
    try {
      if (this.hasAttribute("modeless")) this.surface.show();
      else this.surface.showModal();
    } catch {
      this.pending = false;
      this.setOpenAttribute(false);
      return;
    }
    const first = this.surface.querySelector("[autofocus]") ?? focusables(this.body)[0] ?? focusables(this.footer)[0] ?? this.closeButton;
    first.focus();
  }

  /** Closes the dialog; it then sends prism-close and returns focus. */
  close() {
    if (!this.surface?.open) return;
    this.surface.close();
    this.closed();
  }

  // Finishes one opening exactly once, whichever comes first: close() or the surface's close event. A late close event from an earlier opening finds the surface open again or the opening finished, and changes nothing.
  closed() {
    if (!this.pending || this.surface.open) return;
    this.pending = false;
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
