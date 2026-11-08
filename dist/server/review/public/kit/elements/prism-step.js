// prism-step: One phase of a prism-stepper with its state.
import { Base, setAttribute } from "./base.js";

export class PrismStep extends Base {
  static tag = "prism-step";
  static catalog = {
    purpose: "One phase of a prism-stepper with its state.",
    options: [{ name: "phase", values: ["requirements", "design", "frozen", "build", "review", "shipped"], default: "", description: "The phase." }, { name: "state", values: ["done", "current", "upcoming"], default: "upcoming", description: "Where the slice is." }],
    states: ["done", "current", "upcoming"],
    keyboard: []
  };

  connectedCallback() {
    setAttribute(this, "role", "listitem");
    setAttribute(this, "aria-current", this.getAttribute("state") === "current" ? "step" : null);
  }
}
