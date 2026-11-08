// prism-empty-state: Says that a place has nothing to show yet, with a heading and what to do next.
import { Base, setAttribute } from "./base.js";

export class PrismEmptyState extends Base {
  static tag = "prism-empty-state";
  static catalog = {
    purpose: "Says that a place has nothing to show yet, with a heading and what to do next.",
    options: [{ name: "heading", values: ["text"], default: "", description: "What is missing." }],
    states: ["default"],
    keyboard: []
  };

  connectedCallback() {
    if (!this.headingElement) {
      this.headingElement = this.ownerDocument.createElement("p");
      this.headingElement.className = "prism-empty-state-heading";
      this.prepend(this.headingElement);
    }
    this.headingElement.textContent = this.getAttribute("heading") ?? "";
  }
}
