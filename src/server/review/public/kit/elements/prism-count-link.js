// prism-count-link: one link of a list of counts in light DOM, such as a menu's way to a filtered page: a leading glyph, its label, and a count badge at its end.
// The page handles the link's click itself when it opens the address in place.
import { Base, distribute, make, setAttribute } from "./base.js";
import { ICON_NAMES } from "./prism-icon.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

export class PrismCountLink extends Base {
  static tag = "prism-count-link";
  static observedAttributes = ["href", "icon", "count"];
  static catalog = {
    purpose: "A link to a filtered page that says how many items wait there: a glyph, a label that shortens with an ellipsis, and a count badge, shown even at 0; links in a .prism-count-links list stack with a line between them.",
    options: [
      { name: "href", values: ["url"], default: "", description: "Where the link leads." },
      { name: "icon", values: ICON_NAMES, default: "", description: "The glyph before the label." },
      { name: "count", values: ["number"], default: "0", description: "The count badge at the end." }
    ],
    states: ["default", "zero", "list", "long-text"],
    keyboard: ["Tab reaches the link, and Enter follows it."]
  };

  connectedCallback() {
    if (!this.anchor) {
      this.anchor = make(this, "a", "prism-count-link-anchor");
      this.glyph = make(this, "prism-icon", "prism-count-link-glyph", { size: "sm", "aria-hidden": "true" });
      this.label = make(this, "span", "prism-count-link-label");
      this.badge = make(this, "prism-badge", "prism-count-link-count", { tone: "neutral", size: "sm" });
      this.anchor.append(this.glyph, this.label, this.badge);
      this.append(this.anchor);
      this.children$ = distribute(this, { default: this.label }, [this.anchor]);
    }
    this.attributeChangedCallback();
    // A shortened label shows its full text in the tooltip; the link already takes focus.
    watchShortening(this, this.label, { focusable: () => true });
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  get tooltipText() {
    return this.label?.textContent.replace(/\s+/g, " ").trim() ?? "";
  }

  attributeChangedCallback() {
    if (!this.anchor) return;
    setAttribute(this.anchor, "href", this.getAttribute("href") || "#");
    const icon = this.getAttribute("icon");
    this.glyph.hidden = !icon;
    if (icon) setAttribute(this.glyph, "name", icon);
    const count = String(Math.max(0, Number.parseInt(this.getAttribute("count") ?? "", 10) || 0));
    if (this.badge.textContent !== count) this.badge.textContent = count;
  }
}
