// prism-line-delta: the added and removed line counts of a version, such as +3 −2, in the diff colors, in light DOM, named in words to assistive technology.
import { Base, make, setAttribute } from "./base.js";

/** A whole number from an attribute, or null when the attribute is absent or holds no whole number. */
function count(value: string | null) {
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
}

export class PrismLineDelta extends Base {
  declare addedPart: any;
  declare gap: any;
  declare removedPart: any;
  static tag = "prism-line-delta";
  static observedAttributes = ["added", "removed"];
  static catalog = {
    purpose: "The added and removed line counts of a version, such as +3 −2, in the added-line and removed-line colors; it stays on one line beside a long text, and assistive technology reads it as 3 lines added, 2 lines removed, or 1 line added for a count of 1.",
    options: [
      { name: "added", values: ["whole number"], default: "", description: "The number of added lines, shown as +<added>; without it the added part is left out." },
      { name: "removed", values: ["whole number"], default: "", description: "The number of removed lines, shown as −<removed>; without it the removed part is left out." }
    ],
    states: ["both", "added-only", "removed-only", "zero"],
    keyboard: ["A line delta takes no keys; it is text."]
  };

  connectedCallback() {
    if (!this.addedPart) this.build();
    this.sync();
  }

  attributeChangedCallback() {
    if (this.addedPart) this.sync();
  }

  build() {
    this.addedPart = make(this, "span", "prism-line-delta-added", { "aria-hidden": "true" });
    this.removedPart = make(this, "span", "prism-line-delta-removed", { "aria-hidden": "true" });
    this.gap = this.ownerDocument.createTextNode(" ");
    this.replaceChildren(this.addedPart, this.gap, this.removedPart);
  }

  sync() {
    const added = count(this.getAttribute("added"));
    const removed = count(this.getAttribute("removed"));
    this.addedPart.textContent = added === null ? "" : `+${added}`;
    this.addedPart.hidden = added === null;
    this.removedPart.textContent = removed === null ? "" : `−${removed}`;
    this.removedPart.hidden = removed === null;
    this.gap.textContent = added !== null && removed !== null ? " " : "";
    const noun = (n: number) => (n === 1 ? "line" : "lines");
    const words = [added === null ? "" : `${added} ${noun(added)} added`, removed === null ? "" : `${removed} ${noun(removed)} removed`].filter(Boolean).join(", ");
    setAttribute(this, "role", words ? "img" : null);
    setAttribute(this, "aria-label", words || null);
  }
}
