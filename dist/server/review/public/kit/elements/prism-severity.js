// Generated from src/server/review/public/kit/elements/prism-severity.ts by scripts/native-build/compile.mjs.
import { Base, setAttribute, shadow } from "./base.js";
const SEVERITIES = Object.freeze({ blocker: "Blocker", high: "High", medium: "Medium", low: "Low" });
const FILLED = { low: 1, medium: 2, high: 3, blocker: 3 };
class PrismSeverity extends Base {
  static tag = "prism-severity";
  static styles = ["prism-severity.css"];
  static observedAttributes = ["level", "glyph-only"];
  static catalog = {
    purpose: "The severity of a review finding as three rising bars filled up to its level, blocker in the danger color and high in the warning color, with its word unless glyph-only. Static text that is never a control.",
    options: [
      { name: "level", values: Object.keys(SEVERITIES), default: "low", description: "The finding's severity; an unknown level reads as low." },
      { name: "glyph-only", values: ["boolean"], default: "false", description: "Shows only the bars, such as in a list row; the word becomes its accessible name and tooltip." }
    ],
    states: [...Object.keys(SEVERITIES), "glyph-only"],
    keyboard: []
  };
  constructor() {
    super();
    this.root = shadow(this, PrismSeverity.styles, `<span class="bars" part="bars" aria-hidden="true"><b></b><b></b><b></b></span><span class="word" part="word"></span>`);
  }
  connectedCallback() {
    this.render();
  }
  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }
  get level() {
    const level = this.getAttribute("level");
    return Object.hasOwn(SEVERITIES, level) ? level : "low";
  }
  render() {
    const level = this.level;
    const word = SEVERITIES[level];
    const glyphOnly = this.hasAttribute("glyph-only");
    this.dataset.level = level;
    [...this.root.querySelectorAll(".bars b")].forEach((bar, index) => bar.classList.toggle("is-filled", index < FILLED[level]));
    this.root.querySelector(".word").textContent = glyphOnly ? "" : word;
    setAttribute(this, "role", glyphOnly ? "img" : null);
    setAttribute(this, "aria-label", glyphOnly ? `${word} severity` : null);
    setAttribute(this, "tip", glyphOnly ? `${word} severity` : null);
  }
}
export {
  PrismSeverity,
  SEVERITIES
};
