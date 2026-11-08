// prism-stat: one figure with its label, a hint, and a tone.
import { Base, shadow } from "./base.js";

export class PrismStat extends Base {
  static tag = "prism-stat";
  static styles = ["prism-stat.css"];
  static observedAttributes = ["label", "value", "hint", "tone"];
  static catalog = {
    purpose: "One figure with its label and an optional hint, such as a count of open findings.",
    options: [
      { name: "label", values: ["text"], default: "", description: "What the figure counts." },
      { name: "value", values: ["text"], default: "", description: "The figure." },
      { name: "hint", values: ["text"], default: "", description: "Quieter text below the figure." },
      { name: "tone", values: ["neutral", "accent", "danger", "warning", "success", "info"], default: "neutral", description: "The figure's color." }
    ],
    states: ["default", "tone"],
    keyboard: []
  };

  constructor() {
    super();
    // The words live in light DOM, slotted into the tile, so they read as the element's own text.
    this.root = shadow(this, PrismStat.styles, `<div class="stat" part="stat"><slot name="label"></slot><slot name="value"></slot><slot name="hint"></slot></div>`);
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const parts = ["label", "value", "hint"].filter((name) => this.getAttribute(name)).map((name) => {
      const part = this.ownerDocument.createElement("span");
      part.slot = name;
      part.textContent = this.getAttribute(name);
      return part;
    });
    this.replaceChildren(...parts);
  }
}
