// prism-row: one row of a list of rows in light DOM, a `.prism-rows` list whose rows share their columns: a kind tile, a title over a description
// and an optional detail, then a kind, a time, and an action, each lined up down the list.
import { Base, make, setAttribute } from "./base.js";
import { ICON_NAMES } from "./prism-icon.js";
import { TONES } from "./prism-chip.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

const SLOTS = ["description", "detail", "kind", "time", "action"];

export class PrismRow extends Base {
  static tag = "prism-row";
  static tooltipBoundary = true;
  static observedAttributes = ["icon", "tone", "wrap"];
  static catalog = {
    purpose: "One row of a .prism-rows list, whose rows share their columns: a kind tile, its title on one line over a description and an optional detail, then its kind, time, and action, lined up down the list; a phone-width window keeps the tile, the text, and the action.",
    options: [
      { name: "icon", values: ICON_NAMES, default: "", description: "Draws a kind tile with this glyph at the start." },
      { name: "tone", values: TONES, default: "neutral", description: "The kind tile's color." },
      { name: "wrap", values: ["boolean"], default: "false", description: "Lets the title wrap and sets the tile at the top, for a row that shows its detail in full." },
      { name: "slot=\"description\"", values: ["children"], default: "", description: "The second line, such as where the item belongs and what it is." },
      { name: "slot=\"detail\"", values: ["children"], default: "", description: "A further line under the description, shown whole, such as the answer that was given." },
      { name: "slot=\"kind\"", values: ["children"], default: "", description: "The kind column, such as a prism-chip." },
      { name: "slot=\"time\"", values: ["children"], default: "", description: "The time column, such as a <time> of how long ago." },
      { name: "slot=\"action\"", values: ["children"], default: "", description: "The action column, such as a small prism-button." }
    ],
    states: ["default", "linked", "no-action", "wrap"],
    keyboard: ["A link or button in the row is reached by Tab; a shortened title shows its full text in the tooltip."]
  };

  connectedCallback() {
    if (!this.titleElement) this.build();
    setAttribute(this, "role", "listitem");
    this.attributeChangedCallback();
    watchShortening(this, this.titleElement, { focusable: () => Boolean(this.querySelector("a[href], prism-button")) });
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  attributeChangedCallback() {
    if (!this.titleElement) return;
    const icon = this.getAttribute("icon");
    // A row without a kind keeps the tile's room, so its text lines up with the other rows'.
    this.tile.toggleAttribute("data-none", !icon);
    if (icon) this.tileIcon.setAttribute("name", icon);
    setAttribute(this.tile, "data-tone", this.getAttribute("tone") || null);
  }

  build() {
    this.tile = make(this, "span", "prism-row-tile", { "aria-hidden": "true" });
    this.tileIcon = make(this, "prism-icon", "", { size: "sm" });
    this.tile.append(this.tileIcon);
    const text = make(this, "span", "prism-row-text");
    this.titleElement = make(this, "span", "prism-row-title");
    this.regions = Object.fromEntries(SLOTS.map((slot) => [slot, make(this, "span", `prism-row-${slot}`)]));
    const own = new Set([this.tile, text, ...["kind", "time", "action"].map((slot) => this.regions[slot])]);
    const place = () => {
      for (const node of [...this.childNodes]) {
        if (own.has(node)) continue;
        const slot = node.nodeType === 1 ? node.getAttribute("slot") : null;
        (SLOTS.includes(slot) ? this.regions[slot] : this.titleElement).append(node);
      }
      this.regions.description.hidden = this.regions.description.childNodes.length === 0;
      this.regions.detail.hidden = this.regions.detail.childNodes.length === 0;
    };
    text.append(this.titleElement, this.regions.description, this.regions.detail);
    this.append(this.tile, text, this.regions.kind, this.regions.time, this.regions.action);
    place();
    this.children$ = new MutationObserver(place);
    this.children$.observe(this, { childList: true });
  }

  get tooltipText() {
    return this.titleElement?.textContent.replace(/\s+/g, " ").trim() ?? "";
  }
}
