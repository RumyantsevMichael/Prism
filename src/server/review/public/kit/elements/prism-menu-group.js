// prism-menu-group: a named group of menu items, such as the radio items of one choice, as a list, as tiles, or as a segmented switch.
import { Base, distribute, setAttribute, uniqueId } from "./base.js";

const LAYOUTS = ["list", "tiles", "segmented"];

export class PrismMenuGroup extends Base {
  static tag = "prism-menu-group";
  static observedAttributes = ["label", "layout"];
  static catalog = {
    purpose: "A named group of items inside a prism-menu; the radio items of a group are one choice, shown as a list, as tiles, or as a segmented switch.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The group's name, shown above its items and used as its accessible name." },
      { name: "layout", values: LAYOUTS, default: "list", description: "list stacks its items as rows; tiles sets prism-menu-item tiles side by side, such as theme previews; segmented draws its segment items as one switch, such as density." }
    ],
    states: ["default", "tiles", "segmented"],
    keyboard: ["ArrowUp and ArrowDown move through the items of every group of the menu in order.", "In tiles or a segmented switch, ArrowLeft and ArrowRight also move between the group's items, wrapping at its ends."]
  };

  connectedCallback() {
    setAttribute(this, "role", "group");
    if (!this.heading) {
      this.heading = this.ownerDocument.createElement("div");
      this.heading.className = "prism-menu-group-label";
      this.heading.id = uniqueId("prism-menu-group");
      this.heading.setAttribute("aria-hidden", "true");
      this.itemsElement = this.ownerDocument.createElement("div");
      this.itemsElement.className = "prism-menu-group-items";
    }
    if (this.firstElementChild !== this.heading) this.prepend(this.heading);
    if (this.heading.nextElementSibling !== this.itemsElement) this.heading.after(this.itemsElement);
    this.children$ ??= distribute(this, { default: this.itemsElement }, [this.heading, this.itemsElement]);
    this.attributeChangedCallback();
  }

  /** The layout the group draws, list unless it names tiles or segmented. */
  get layout() {
    return LAYOUTS.includes(this.getAttribute("layout")) ? this.getAttribute("layout") : "list";
  }

  attributeChangedCallback() {
    if (!this.heading) return;
    const label = this.getAttribute("label") ?? "";
    this.heading.textContent = label;
    this.heading.hidden = !label;
    setAttribute(this, "aria-label", label || null);
  }
}
