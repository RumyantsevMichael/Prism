// prism-stat: one figure with its label, a hint, and a tone.
import { Base, escapeHtml, shadow } from "./base.js";

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
    this.root = shadow(this, PrismStat.styles, "");
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const read = (name) => escapeHtml(this.getAttribute(name) ?? "");
    this.root.innerHTML = `<div class="stat" part="stat"><span class="label">${read("label")}</span><span class="value">${read("value")}</span>${this.getAttribute("hint") ? `<span class="hint">${read("hint")}</span>` : ""}</div>`;
  }
}
