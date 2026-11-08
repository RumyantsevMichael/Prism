// prism-banner: A message across the top of a place, in a tone.
import { Base, setAttribute } from "./base.js";

export class PrismBanner extends Base {
  static tag = "prism-banner";
  static catalog = {
    purpose: "A message across the top of a place, in a tone.",
    options: [{ name: "tone", values: ["info", "warning", "danger", "success"], default: "info", description: "The message tone; danger is an alert." }, { name: "heading", values: ["text"], default: "", description: "The message heading." }, { name: "dismissible", values: ["boolean"], default: "false", description: "Adds a Dismiss button." }],
    states: ["info", "warning", "danger", "success"],
    keyboard: []
  };

  connectedCallback() {
    setAttribute(this, "role", this.getAttribute("tone") === "danger" ? "alert" : "status");
    if (!this.headingElement) {
      this.headingElement = this.ownerDocument.createElement("p");
      this.headingElement.className = "prism-banner-heading";
      this.prepend(this.headingElement);
    }
    this.headingElement.textContent = this.getAttribute("heading") ?? "";
    this.headingElement.hidden = !this.getAttribute("heading");
  }
}
