// prism-tree: A tree of items that expand and collapse, such as the sidebar navigation.
import { Base, setAttribute } from "./base.js";

export class PrismTree extends Base {
  static tag = "prism-tree";
  static catalog = {
    purpose: "A tree of items that expand and collapse, such as the sidebar navigation.",
    options: [{ name: "label", values: ["text"], default: "", description: "The tree accessible name." }],
    states: ["default"],
    keyboard: []
  };

  connectedCallback() {
    setAttribute(this, "role", "tree");
    setAttribute(this, "aria-label", this.getAttribute("label") || null);
  }
}
