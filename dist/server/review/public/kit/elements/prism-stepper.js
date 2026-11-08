// prism-stepper: The lifecycle of a slice as a row of phase steps.
import { Base, setAttribute } from "./base.js";

export class PrismStepper extends Base {
  static tag = "prism-stepper";
  static catalog = {
    purpose: "The lifecycle of a slice as a row of phase steps.",
    options: [{ name: "label", values: ["text"], default: "", description: "The list accessible name." }],
    states: ["default"],
    keyboard: []
  };

  connectedCallback() {
    setAttribute(this, "role", "list");
    setAttribute(this, "aria-label", this.getAttribute("label") || null);
  }
}
