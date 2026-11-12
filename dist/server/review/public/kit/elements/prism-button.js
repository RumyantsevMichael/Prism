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
      { name: "variant", values: ["default", "primary", "ghost", "danger", "chrome", "status", "search"], default: "default", description: "Primary for the one main action of a place, ghost for quiet tool buttons, danger for an action that removes or rejects, chrome for a quiet button on the canvas that lifts onto the surface while its menu or popover is open, status for a status bar item in small text whose fill stays inside the bar, and search for a button that reads as a search field, its text at the left and a key hint at its end." },
      { name: "shape", values: ["default", "round"], default: "default", description: "round draws a pill, and a pressed pill takes the accent, as a filter does." },
      { name: "size", values: ["md", "sm"], default: "md", description: "md takes --prism-control-height and sm takes --prism-control-height-sm." },
      { name: "disabled", values: ["boolean"], default: "false", description: "The button sends no click and leaves the Tab order." },
      { name: "pressed", values: ["boolean", "false"], default: "", description: "Makes it a toggle and exposes the state as aria-pressed." },
      { name: "label", values: ["text"], default: "", description: "The accessible name of a button that shows only an icon." },
      { name: "tip", values: ["text"], default: "", description: "A short description the kit tooltip shows on hover and keyboard focus." },
      { name: "slot=\"badge\"", values: ["children"], default: "", description: "A prism-badge on the button's top end corner, such as a count on an icon button." }
    ],
    states: ["default", "primary", "ghost", "danger", "chrome", "status", "search", "round", "small", "disabled", "pressed", "icon-only", "badge"],
    keyboard: ["Enter and Space activate the button.", "A disabled button is skipped by Tab."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismButton.styles, `<button type="button" part="control"><span class="content" part="content"><slot></slot></span></button><span class="badge" part="badge" hidden><slot name="badge"></slot></span>`, { delegatesFocus: true });
    this.control = this.root.querySelector("button");
    const badge = this.root.querySelector(".badge");
    const badgeSlot = badge.querySelector("slot");
    badgeSlot.addEventListener("slotchange", () => {
      badge.hidden = badgeSlot.assignedElements().length === 0;
    });
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
