// prism-state: an initiative's lifecycle state as a round glyph and its name: dotted while envisioned, dashed while planned, half full in progress, and full once shipped.
import { Base, setAttribute, shadow } from "./base.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

export const STATES = Object.freeze(["envisioned", "planned", "in-progress", "shipped", "superseded"]);

export class PrismState extends Base {
  static tag = "prism-state";
  static styles = ["prism-state.css"];
  static observedAttributes = ["label"];
  static catalog = {
    purpose: "An initiative's lifecycle state as a round glyph and its name in the state's color; static text that is never a control.",
    options: [
      { name: "state", values: STATES, default: "envisioned", description: "The state, which draws the glyph: dotted, dashed, half full, full, or struck through." },
      { name: "label", values: ["text"], default: "", description: "Without text, the glyph alone shows and this names it for assistive technology, such as in a tree row." }
    ],
    states: STATES,
    keyboard: ["A state whose text is shortened joins the Tab order so its full text can be read."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismState.styles, `<span class="state" part="state"><span class="glyph" aria-hidden="true"></span><span class="text"><slot></slot></span></span>`);
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
