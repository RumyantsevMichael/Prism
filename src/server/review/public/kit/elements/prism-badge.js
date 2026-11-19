// prism-badge: a count or a status in a tone, static text with no role of a control.
import { Base, setAttribute, shadow } from "./base.js";
import { unwatchShortening, watchShortening } from "../shorten.js";
import { TONES } from "./prism-chip.js";

export class PrismBadge extends Base {
  static tag = "prism-badge";
  static styles = ["prism-badge.css"];
  static observedAttributes = ["note"];
  static catalog = {
    purpose: "A count or a status in a tone; static text that is never a control.",
    options: [
      { name: "tone", values: TONES, default: "accent", description: "The color of the badge; the text stays at 4.5:1 on its soft fill." },
      { name: "variant", values: ["count", "status"], default: "count", description: "count is a round pill for a number, status shows a dot before a word." },
      { name: "solid", values: ["boolean"], default: "false", description: "Fills an accent count with the accent itself, for a count that asks for the user, such as Attention's." },
      { name: "size", values: ["md", "sm"], default: "md", description: "sm takes --prism-badge-size-sm, for a count on the corner of an icon button." },
      { name: "note", values: ["text"], default: "", description: "What the badge stands for in more words, such as the rules a mark names; the badge carries it as its title, which a pointer shows on hover and assistive technology reads as its description." }
    ],
    states: ["count", "status", "tones", "solid"],
    keyboard: ["A badge whose text is shortened joins the Tab order so its full text can be read."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismBadge.styles, `<span class="badge" part="badge"><span class="dot" aria-hidden="true"></span><span class="text"><slot></slot></span></span>`);
  }

  connectedCallback() {
    this.attributeChangedCallback();
    watchShortening(this, this.root.querySelector(".text"));
  }

  attributeChangedCallback() {
    setAttribute(this, "title", this.getAttribute("note") || null);
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }
}
