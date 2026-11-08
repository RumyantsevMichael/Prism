// prism-tree-item: One item of a prism-tree, with its label, value, and child items.
import { Base, setAttribute } from "./base.js";

export class PrismTreeItem extends Base {
  static tag = "prism-tree-item";
  static catalog = {
    purpose: "One item of a prism-tree, with its label, value, and child items.",
    options: [{ name: "label", values: ["text"], default: "", description: "The item label." }, { name: "value", values: ["text"], default: "", description: "The value the tree sends when the item is chosen." }, { name: "expanded", values: ["boolean"], default: "false", description: "Whether its child items show." }, { name: "selected", values: ["boolean"], default: "false", description: "Whether the item is the current one." }],
    states: ["default"],
    keyboard: []
  };

  connectedCallback() {
    setAttribute(this, "role", "treeitem");
    if (!this.labelElement) {
      this.labelElement = this.ownerDocument.createElement("span");
      this.labelElement.className = "prism-tree-item-label";
      this.prepend(this.labelElement);
    }
    this.labelElement.textContent = this.getAttribute("label") ?? "";
  }
}
