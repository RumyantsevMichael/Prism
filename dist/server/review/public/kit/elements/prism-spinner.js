// Generated from src/server/review/public/kit/elements/prism-spinner.ts by scripts/native-build/compile.mjs.
import { Base, setAttribute, shadow } from "./base.js";
class PrismSpinner extends Base {
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
    const label = this.getAttribute("label") || "Loading";
    this.root.querySelector(".label").textContent = label;
    setAttribute(this, "aria-label", label);
  }
}
export {
  PrismSpinner
};
