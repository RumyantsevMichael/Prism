// prism-stat: one figure with its label, a hint, a tone, an optional glyph, and a layout.
import { Base, shadow } from "./base.js";
import { ICON_NAMES } from "./prism-icon.js";

export class PrismStat extends Base {
  static tag = "prism-stat";
  static styles = ["prism-stat.css"];
  static observedAttributes = ["label", "value", "hint", "tone", "icon"];
  static catalog = {
    purpose: "One figure with its label and an optional hint, such as a count of open findings.",
    options: [
      { name: "label", values: ["text"], default: "", description: "What the figure counts." },
      { name: "value", values: ["text"], default: "", description: "The figure." },
      { name: "hint", values: ["text"], default: "", description: "Quieter text below the figure." },
      { name: "tone", values: ["neutral", "accent", "danger", "warning", "success", "info"], default: "neutral", description: "The figure's color." },
      { name: "layout", values: ["stacked", "inline", "figure"], default: "stacked", description: "stacked puts the label above the figure, inline puts the figure before its label on one line, as in a page's summary, and figure puts the figure above its label, as evidence does." },
      { name: "icon", values: ICON_NAMES, default: "", description: "A glyph before the figure, in the figure's tone." }
    ],
    states: ["default", "tone", "inline", "figure"],
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
    const icon = this.getAttribute("icon");
    const value = parts.find((part) => part.slot === "value");
    if (icon && value) {
      const glyph = this.ownerDocument.createElement("prism-icon");
      glyph.setAttribute("name", icon);
      value.prepend(glyph);
    }
    this.replaceChildren(...parts);
  }
}
