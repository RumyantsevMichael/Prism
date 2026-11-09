// prism-button: one native button around its content, in the kit's variants and sizes.
import { Base, setAttribute, shadow } from "./base.js";
import { watchShortening, unwatchShortening } from "../shorten.js";

// Attributes a menu, popover, or page sets on the kit button that reach the native button inside it.
const FORWARDED = ["aria-haspopup", "aria-expanded", "aria-controls", "aria-describedby", "aria-keyshortcuts"];

export class PrismButton extends Base {
  static tag = "prism-button";
  static styles = ["prism-button.css"];
  static observedAttributes = ["disabled", "pressed", "label", ...FORWARDED];
  static catalog = {
    purpose: "A button that runs one action: one native button around its text and icons, in a variant and a size.",
    options: [
      { name: "variant", values: ["default", "primary", "ghost", "danger"], default: "default", description: "Primary for the one main action of a place, ghost for quiet tool buttons, danger for an action that removes or rejects." },
      { name: "size", values: ["md", "sm"], default: "md", description: "md takes --prism-control-height and sm takes --prism-control-height-sm." },
      { name: "disabled", values: ["boolean"], default: "false", description: "The button sends no click and leaves the Tab order." },
      { name: "pressed", values: ["boolean", "false"], default: "", description: "Makes it a toggle and exposes the state as aria-pressed." },
      { name: "label", values: ["text"], default: "", description: "The accessible name of a button that shows only an icon." },
      { name: "tip", values: ["text"], default: "", description: "A short description the kit tooltip shows on hover and keyboard focus." }
    ],
    states: ["default", "primary", "ghost", "danger", "small", "disabled", "pressed", "icon-only"],
    keyboard: ["Enter and Space activate the button.", "A disabled button is skipped by Tab."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismButton.styles, `<button type="button" part="control"><span class="content" part="content"><slot></slot></span></button>`, { delegatesFocus: true });
    this.control = this.root.querySelector("button");
    // A disabled button sends no click, also when the click lands on the element's own box.
    this.addEventListener("click", (event) => {
      if (this.hasAttribute("disabled")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, { capture: true });
  }

  connectedCallback() {
    this.sync();
    watchShortening(this, this.root.querySelector(".content"), { focusable: () => true });
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  attributeChangedCallback() {
    this.sync();
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  set disabled(value) {
    this.toggleAttribute("disabled", Boolean(value));
  }

  get pressed() {
    return this.hasAttribute("pressed") && this.getAttribute("pressed") !== "false";
  }

  set pressed(value) {
    this.setAttribute("pressed", value ? "" : "false");
  }

  focus(options) {
    this.control.focus(options);
  }

  click() {
    this.control.click();
  }

  sync() {
    const control = this.control;
    control.disabled = this.hasAttribute("disabled");
    setAttribute(control, "aria-pressed", this.hasAttribute("pressed") ? String(this.pressed) : null);
    setAttribute(control, "aria-label", this.getAttribute("label") || null);
    for (const name of FORWARDED) setAttribute(control, name, this.getAttribute(name));
  }
}
