// prism-menu-group: a named group of menu items, such as the radio items of one choice.
import { Base, setAttribute, uniqueId } from "./base.js";

export class PrismMenuGroup extends Base {
  static tag = "prism-menu-group";
  static observedAttributes = ["label"];
  static catalog = {
    purpose: "A named group of items inside a prism-menu; the radio items of a group are one choice.",
    options: [{ name: "label", values: ["text"], default: "", description: "The group's name, shown above its items and used as its accessible name." }],
    states: ["default"],
    keyboard: ["Arrow keys move through the items of every group of the menu in order."]
  };

  connectedCallback() {
    setAttribute(this, "role", "group");
    if (!this.heading) {
      this.heading = this.ownerDocument.createElement("div");
      this.heading.className = "prism-menu-group-label";
      this.heading.id = uniqueId("prism-menu-group");
      this.heading.setAttribute("aria-hidden", "true");
    }
    if (this.firstElementChild !== this.heading) this.prepend(this.heading);
    this.attributeChangedCallback();
  }

  attributeChangedCallback() {
    if (!this.heading) return;
    const label = this.getAttribute("label") ?? "";
    this.heading.textContent = label;
    this.heading.hidden = !label;
    setAttribute(this, "aria-label", label || null);
  }
}
