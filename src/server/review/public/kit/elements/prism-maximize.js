// prism-maximize: the icon button that maximizes a region and restores it, named Maximize or Restore by its maximized attribute.
// It renders a kit button in light DOM and does not change its own state: a click sends prism-maximize-request with detail.maximized, the state asked for,
// and whoever owns the region, such as prism-panel or a page, sets maximized when it applies that state.
import { Base, emit, make, setAttribute } from "./base.js";

export class PrismMaximize extends Base {
  static tag = "prism-maximize";
  static observedAttributes = ["maximized", "floating"];
  static catalog = {
    purpose: "The icon button that maximizes a region to fill the window and restores it; the region's owner applies the state the button asks for.",
    options: [
      { name: "maximized", values: ["boolean"], default: "false", description: "The region is maximized, so the button is named Restore, shows the restore icon, and reads as pressed." },
      { name: "floating", values: ["boolean"], default: "false", description: "Placed first in a region that has no header, the button floats at the region's top end corner and stays in view while the region scrolls." }
    ],
    states: ["default", "maximized", "floating", "long-text", "unbroken-name"],
    keyboard: ["Enter and Space press the button.", "Its tip names Escape, which the region's owner handles to restore."]
  };

  connectedCallback() {
    if (!this.button) {
      this.button = make(this, "prism-button", "prism-maximize-button", { variant: "ghost", size: "sm" });
      this.button.append(make(this, "prism-icon"));
      this.button.addEventListener("click", () => emit(this, "prism-maximize-request", { maximized: !this.hasAttribute("maximized") }));
      this.append(this.button);
    }
    this.sync();
  }

  attributeChangedCallback() {
    if (this.button) this.sync();
  }

  sync() {
    const maximized = this.hasAttribute("maximized");
    setAttribute(this.button, "label", maximized ? "Restore" : "Maximize");
    setAttribute(this.button, "tip", maximized ? "Restore (Esc)" : "Fill the window");
    setAttribute(this.button, "pressed", String(maximized));
    setAttribute(this.button.firstElementChild, "name", maximized ? "restore" : "maximize");
  }

  focus(options) {
    this.button?.focus(options);
  }
}
