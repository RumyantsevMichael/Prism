// prism-stepper: a list of prism-step items, each with its state in words: the lifecycle of a slice as a row of phase bars,
// or, vertical, the steps of a process as dots on a rail with a detail under the current one, such as an index build.
import { Base, setAttribute } from "./base.js";

export class PrismStepper extends Base {
  static tag = "prism-stepper";
  static observedAttributes = ["label", "orientation"];
  static catalog = {
    purpose: "The lifecycle of a slice as a row of phase steps: done and current steps draw their phase color, upcoming ones the strong line, and the current one is marked. Vertical, the steps of a process hang as dots on a rail that runs from the first dot to the last, each dot centered on its label's first line.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The list's accessible name, such as Lifecycle." },
      { name: "orientation", values: ["horizontal", "vertical"], default: "horizontal", description: "Vertical draws each step as a dot on a rail, done steps filled in the success color and the current one in the accent, unless a phase gives the color; a step's slot=\"detail\" children show under its label." }
    ],
    states: ["default", "early", "shipped", "vertical"],
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
