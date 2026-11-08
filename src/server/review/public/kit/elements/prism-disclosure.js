// prism-disclosure: A summary that shows or hides the content below it.
import { Base, setAttribute } from "./base.js";

export class PrismDisclosure extends Base {
  static tag = "prism-disclosure";
  static catalog = {
    purpose: "A summary that shows or hides the content below it.",
    options: [{ name: "summary", values: ["text"], default: "", description: "The toggle text." }, { name: "open", values: ["boolean"], default: "false", description: "Whether the content shows." }],
    states: ["closed"],
    keyboard: []
  };

  connectedCallback() {
    if (!this.summaryElement) {
      this.summaryElement = this.ownerDocument.createElement("p");
      this.summaryElement.className = "prism-disclosure-summary";
      this.prepend(this.summaryElement);
    }
    this.summaryElement.textContent = this.getAttribute("summary") ?? "";
  }
}
