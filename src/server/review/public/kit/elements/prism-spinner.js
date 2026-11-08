// prism-spinner: a small turning ring that says something is loading, still under reduced motion.
import { Base, setAttribute, shadow } from "./base.js";

export class PrismSpinner extends Base {
  static tag = "prism-spinner";
  static styles = ["prism-spinner.css"];
  static observedAttributes = ["label"];
  static catalog = {
    purpose: "A small turning ring with the role status that says something is loading; it stands still under reduced motion.",
    options: [{ name: "label", values: ["text"], default: "Loading", description: "What is loading, as the status text for assistive technology." }],
    states: ["default"],
    keyboard: []
  };

  constructor() {
    super();
    this.root = shadow(this, PrismSpinner.styles, `<span class="ring" part="ring" aria-hidden="true"></span><span class="label"></span>`);
  }

  connectedCallback() {
    setAttribute(this, "role", "status");
    this.attributeChangedCallback();
  }

  attributeChangedCallback() {
    this.root.querySelector(".label").textContent = this.getAttribute("label") || "Loading";
  }
}
