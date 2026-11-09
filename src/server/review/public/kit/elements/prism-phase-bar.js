// prism-phase-bar: one segment per slice in the color of the phase it is in, and a label such as "0 of 5 shipped", as one image for assistive technology.
import { Base, setAttribute, shadow } from "./base.js";
import { PHASES } from "./prism-phase.js";

export class PrismPhaseBar extends Base {
  static tag = "prism-phase-bar";
  static styles = ["prism-phase-bar.css"];
  static observedAttributes = ["phases", "label"];
  static catalog = {
    purpose: "The slices of an initiative as one segment each in the color of the slice's phase, with a label such as 0 of 5 shipped.",
    options: [
      { name: "phases", values: ["comma-separated phases"], default: "", description: `One phase per slice, from ${PHASES.join(", ")}; an empty entry is a slice that has not started and draws the strong line.` },
      { name: "label", values: ["text"], default: "", description: "The text after the bar, which is also the bar's accessible name." }
    ],
    states: ["default", "not-started", "shipped"],
    keyboard: []
  };

  constructor() {
    super();
    this.root = shadow(this, PrismPhaseBar.styles, `<span class="bar" part="bar"></span><span class="label" part="label"></span>`);
  }

  connectedCallback() {
    setAttribute(this, "role", "img");
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const phases = (this.getAttribute("phases") ?? "").split(",").map((phase) => phase.trim());
    const bar = this.root.querySelector(".bar");
    bar.replaceChildren(...(this.getAttribute("phases") === null || this.getAttribute("phases") === "" ? [] : phases).map((phase) => {
      const segment = this.ownerDocument.createElement("i");
      if (PHASES.includes(phase)) segment.dataset.phase = phase;
      return segment;
    }));
    const label = this.getAttribute("label") ?? "";
    this.root.querySelector(".label").textContent = label;
    setAttribute(this, "aria-label", label || null);
  }
}
