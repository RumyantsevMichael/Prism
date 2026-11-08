// prism-step: one phase of a prism-stepper: a bar in the phase's fill when it is done or current, its label, and its state written for assistive technology.
import { Base, make, setAttribute } from "./base.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

const PHASES = ["requirements", "design", "frozen", "build", "review", "shipped"];
const STATES = ["done", "current", "upcoming"];

export class PrismStep extends Base {
  static tag = "prism-step";
  static observedAttributes = ["phase", "state"];
  static catalog = {
    purpose: "One phase of a prism-stepper with its state: a bar in --prism-color-phase-<phase>-fill when done or current and --prism-color-line-strong when upcoming.",
    options: [
      { name: "phase", values: PHASES, default: "", description: "The phase, which gives the bar its color." },
      { name: "state", values: STATES, default: "upcoming", description: "Where the slice is; current is exposed as aria-current=\"step\" and every state is written out for assistive technology." }
    ],
    states: STATES,
    keyboard: []
  };

  connectedCallback() {
    if (!this.nameElement) {
      this.bar = make(this, "span", "prism-step-bar", { "aria-hidden": "true" });
      this.nameElement = make(this, "span", "prism-step-name");
      this.stateElement = make(this, "span", "sr-only");
      this.nameElement.append(...this.childNodes);
      this.append(this.bar, this.nameElement, this.stateElement);
    }
    setAttribute(this, "role", "listitem");
    this.attributeChangedCallback();
    watchShortening(this, this.nameElement);
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  get state() {
    return STATES.includes(this.getAttribute("state")) ? this.getAttribute("state") : "upcoming";
  }

  get tooltipText() {
    return `${this.nameElement?.textContent.trim() ?? ""}, ${this.state}`;
  }

  attributeChangedCallback() {
    if (!this.nameElement) return;
    setAttribute(this, "aria-current", this.state === "current" ? "step" : null);
    this.stateElement.textContent = `, ${this.state}`;
  }
}
