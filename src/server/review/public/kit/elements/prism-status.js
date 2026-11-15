// prism-status: one status of any Prism record, drawn the same way everywhere: a glyph and a word in the color of the status's class.
import { Base, setAttribute, shadow } from "./base.js";
import { STATUS_CLASSES, STATUSES, statusOf } from "../statuses.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

const VARIANTS = ["plain", "pill", "segment"];

export class PrismStatus extends Base {
  static tag = "prism-status";
  static styles = ["prism-status.css"];
  static observedAttributes = ["value", "label", "glyph-only"];
  static catalog = {
    purpose: "The status of a record, such as an initiative, slice, requirement, decision, or review finding, as a glyph and a word in the color of its class: idle, ready, active, waiting, problem, done, or retired. Every status word maps to one class in kit/statuses.js. Static text that is never a control.",
    options: [
      { name: "value", values: Object.keys(STATUSES), default: "", description: "The status word as the record holds it; the registry gives its class and its word, and an unknown word is idle and shows as written." },
      { name: "variant", values: VARIANTS, default: "plain", description: "pill sets the status on a soft fill of its color, for a status that leads a page or a card; segment draws it as a short bar in its color, one per slice of prism-slice-bar." },
      { name: "glyph-only", values: ["boolean"], default: "false", description: "Shows only the glyph, such as in a tree row or a column head; the word becomes its accessible name and tooltip." },
      { name: "label", values: ["text"], default: "", description: "A word to show in place of the registry's, such as Wave 1 open; text content does the same." }
    ],
    states: Object.keys(STATUS_CLASSES).concat(["pill", "glyph-only", "segment"]),
    keyboard: ["A status whose word is shortened joins the Tab order so its full word can be read."]
  };

  #word = null;

  constructor() {
    super();
    this.root = shadow(this, PrismStatus.styles, `<span class="status" part="status"><span class="glyph" aria-hidden="true"></span><span class="text"><slot></slot></span></span>`);
    // Text an author adds after the element connects, as the document parser does, takes the place of the registry's word.
    this.root.querySelector("slot").addEventListener("slotchange", () => this.render());
  }

  connectedCallback() {
    this.render();
    watchShortening(this, this.root.querySelector(".text"));
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const status = statusOf(this.getAttribute("value"));
    setAttribute(this, "data-class", status.cls);
    // The registry's word is written as the element's own text, so page text, find, and copy see it; text an author wrote stays.
    const generated = this.#word?.parentNode === this ? this.#word : null;
    const own = [...this.childNodes].filter((node) => node !== generated).map((node) => node.textContent).join("").trim();
    const word = (this.getAttribute("label") ?? "").trim() || own || status.label;
    const glyphOnly = this.hasAttribute("glyph-only");
    const shown = own || glyphOnly ? "" : word;
    if (!shown) generated?.remove();
    else if (!generated) this.#word = this.appendChild(document.createTextNode(shown));
    else if (generated.data !== shown) generated.data = shown;
    setAttribute(this, "role", glyphOnly ? "img" : null);
    setAttribute(this, "aria-label", glyphOnly ? word : null);
  }

  /** The word the kit tooltip shows for a glyph-only status. */
  get tooltipText() {
    return this.hasAttribute("glyph-only") ? this.getAttribute("aria-label") ?? "" : this.textContent.trim();
  }

  /** The class the status's value belongs to, such as active. */
  get statusClass() {
    return statusOf(this.getAttribute("value")).cls;
  }
}
