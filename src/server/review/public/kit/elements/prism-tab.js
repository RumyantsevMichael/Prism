// prism-tab: one tab of a prism-tabs strip, with its value and selection.
import { Base, setAttribute, shadow } from "./base.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

export class PrismTab extends Base {
  static tag = "prism-tab";
  static styles = ["prism-tab.css"];
  static observedAttributes = ["selected", "disabled"];
  static catalog = {
    purpose: "One tab of a prism-tabs strip: a value, a label, and whether it is the selected tab.",
    options: [
      { name: "value", values: ["text"], default: "", description: "The value prism-tabs sends in prism-select when this tab is chosen." },
      { name: "selected", values: ["boolean"], default: "false", description: "Marks the one selected tab, exposed as aria-selected." },
      { name: "disabled", values: ["boolean"], default: "false", description: "The tab cannot be chosen." },
      { name: "slot=\"start\"", values: ["children"], default: "", description: "An icon before the label." },
      { name: "slot=\"end\"", values: ["children"], default: "", description: "A count after the label, such as a prism-badge." }
    ],
    states: ["selected", "unselected", "disabled"],
    keyboard: ["Inside prism-tabs, arrow keys move between tabs and Enter or Space chooses one."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismTab.styles, `<span class="tab" part="tab"><slot name="start"></slot><span class="text"><slot></slot></span><slot name="end"></slot></span>`);
  }

  connectedCallback() {
    setAttribute(this, "role", "tab");
    this.sync();
    if (!this.closest("prism-tabs") && !this.hasAttribute("tabindex")) this.setAttribute("tabindex", "0");
    watchShortening(this, this.root.querySelector(".text"), { focusable: () => true });
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  attributeChangedCallback() {
    if (this.isConnected) this.sync();
  }

  get value() {
    return this.getAttribute("value") ?? "";
  }

  get selected() {
    return this.hasAttribute("selected");
  }

  set selected(value) {
    this.toggleAttribute("selected", Boolean(value));
  }

  sync() {
    setAttribute(this, "aria-selected", String(this.selected));
    setAttribute(this, "aria-disabled", this.hasAttribute("disabled") ? "true" : null);
  }
}
