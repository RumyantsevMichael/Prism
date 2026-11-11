// prism-phase: a slice phase as the mark's facet in the phase's color and its name, plain or boxed as a tag.
import { Base, setAttribute, shadow } from "./base.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

export const PHASES = Object.freeze(["requirements", "design", "frozen", "build", "review", "shipped"]);

export class PrismPhase extends Base {
  static tag = "prism-phase";
  static styles = ["prism-phase.css"];
  static observedAttributes = ["label"];
  static catalog = {
    purpose: "A slice phase as the facet of the mark in the phase's color and its name, such as the phase a question waits in; static text that is never a control.",
    options: [
      { name: "phase", values: PHASES, default: "", description: "The phase, which gives the facet and the boxed text their color." },
      { name: "variant", values: ["plain", "tag"], default: "plain", description: "plain shows the facet before ink text, tag boxes it with the name in the phase's color." },
      { name: "label", values: ["text"], default: "", description: "Without text, the glyph alone shows and this names it for assistive technology, such as in a tree row." }
    ],
    states: ["plain", "tag", "phases"],
    keyboard: ["A phase whose text is shortened joins the Tab order so its full text can be read."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismPhase.styles, `<span class="phase" part="phase"><span class="facet" aria-hidden="true"></span><span class="text"><slot></slot></span></span>`);
  }

  connectedCallback() {
    this.attributeChangedCallback();
    watchShortening(this, this.root.querySelector(".text"));
  }

  attributeChangedCallback() {
    const label = this.getAttribute("label");
    setAttribute(this, "role", label ? "img" : null);
    setAttribute(this, "aria-label", label || null);
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }
}
