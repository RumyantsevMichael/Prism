// prism-stepper: the lifecycle of a slice as a list of prism-step items, each with a phase bar and its state in words.
import { Base, setAttribute } from "./base.js";

export class PrismStepper extends Base {
  static tag = "prism-stepper";
  static observedAttributes = ["label"];
  static catalog = {
    purpose: "The lifecycle of a slice as a row of phase steps: done and current steps draw their phase color, upcoming ones the strong line, and the current one is marked.",
    options: [{ name: "label", values: ["text"], default: "", description: "The list's accessible name, such as Lifecycle." }],
    states: ["default", "early", "shipped"],
    keyboard: []
  };

  connectedCallback() {
    setAttribute(this, "role", "list");
    this.attributeChangedCallback();
  }

  attributeChangedCallback() {
    setAttribute(this, "aria-label", this.getAttribute("label") || null);
  }
}
