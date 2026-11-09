// prism-menu-item: one item of a prism-menu, an action, a radio choice, or a checkbox.
import { Base, setAttribute, shadow } from "./base.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

const ROLES = { action: "menuitem", radio: "menuitemradio", checkbox: "menuitemcheckbox" };

export class PrismMenuItem extends Base {
  static tag = "prism-menu-item";
  static styles = ["prism-menu-item.css"];
  static observedAttributes = ["type", "checked", "disabled"];
  static catalog = {
    purpose: "One item of a prism-menu: an action, a radio choice among the items of its group, or a checkbox.",
    options: [
      { name: "value", values: ["text"], default: "", description: "The value the menu sends in prism-select when this item is chosen." },
      { name: "type", values: ["action", "radio", "checkbox"], default: "action", description: "The item's role: menuitem, menuitemradio, or menuitemcheckbox." },
      { name: "checked", values: ["boolean"], default: "false", description: "Whether a radio or checkbox item is checked, exposed as aria-checked." },
      { name: "disabled", values: ["boolean"], default: "false", description: "The item cannot be chosen and arrow keys skip it." },
      { name: "slot=\"hint\"", values: ["children"], default: "", description: "Quieter text at the end of the item, such as a shortcut." }
    ],
    states: ["action", "radio", "checked", "checkbox", "disabled", "hint"],
    keyboard: ["Inside an open menu, arrow keys move between items and Enter or Space chooses one."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismMenuItem.styles, `<span class="item" part="item"><span class="check" aria-hidden="true"><prism-icon name="check" size="sm"></prism-icon></span><span class="text"><slot></slot></span><span class="hint"><slot name="hint"></slot></span></span>`);
  }

  connectedCallback() {
    this.sync();
    if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "-1");
    watchShortening(this, this.root.querySelector(".text"), { focusable: () => true });
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  attributeChangedCallback() {
    if (this.isConnected) this.sync();
  }

  get type() {
    const type = this.getAttribute("type");
    return ROLES[type] ? type : "action";
  }

  get value() {
    return this.getAttribute("value") ?? "";
  }

  get checked() {
    return this.hasAttribute("checked");
  }

  set checked(value) {
    this.toggleAttribute("checked", Boolean(value));
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  sync() {
    const type = this.type;
    setAttribute(this, "role", ROLES[type]);
    setAttribute(this, "aria-checked", type === "action" ? null : String(this.checked));
    setAttribute(this, "aria-disabled", this.disabled ? "true" : null);
  }
}
