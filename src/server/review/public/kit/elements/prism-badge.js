// prism-badge: a count or a status in a tone, static text with no role of a control.
import { Base, shadow } from "./base.js";
import { unwatchShortening, watchShortening } from "../shorten.js";
import { TONES } from "./prism-chip.js";

export class PrismBadge extends Base {
  static tag = "prism-badge";
  static styles = ["prism-badge.css"];
  static catalog = {
    purpose: "A count or a status in a tone; static text that is never a control.",
    options: [
      { name: "tone", values: TONES, default: "accent", description: "The color of the badge; the text stays at 4.5:1 on its soft fill." },
      { name: "variant", values: ["count", "status"], default: "count", description: "count is a round pill for a number, status shows a dot before a word." }
    ],
    states: ["count", "status", "tones"],
    keyboard: ["A badge whose text is shortened joins the Tab order so its full text can be read."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismBadge.styles, `<span class="badge" part="badge"><span class="dot" aria-hidden="true"></span><span class="text"><slot></slot></span></span>`);
  }

  connectedCallback() {
    watchShortening(this, this.root.querySelector(".text"));
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }
}
