// prism-inbox-item: one row of a prism-inbox in light DOM: a kind tile or a leading avatar, a title and a description on one line each, and a time at the end.
import { Base, make, setAttribute, toggleAttribute, uniqueId } from "./base.js";
import { ICON_NAMES } from "./prism-icon.js";
import { TONES } from "./prism-chip.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

const SLOTS = ["start", "description", "end"];

export class PrismInboxItem extends Base {
  static tag = "prism-inbox-item";
  static tooltipBoundary = true;
  static observedAttributes = ["selected", "unread", "icon", "tone"];
  static catalog = {
    purpose: "One item of a prism-inbox: a kind tile or a leading avatar, its title and description on one line each, and a time; unread items mark their time with a dot.",
    options: [
      { name: "value", values: ["text"], default: "", description: "The value the inbox sends in prism-select." },
      { name: "selected", values: ["boolean"], default: "false", description: "Whether it is the picked item; exposed as aria-selected." },
      { name: "unread", values: ["boolean"], default: "false", description: "Marks an item the person has not answered yet with a dot before its time." },
      { name: "icon", values: ICON_NAMES, default: "", description: "Draws a kind tile with this glyph at the start." },
      { name: "tone", values: TONES, default: "neutral", description: "The kind tile's color." },
      { name: "slot=\"start\"", values: ["children"], default: "", description: "Leading content in place of the kind tile, such as a claim's avatar." },
      { name: "slot=\"description\"", values: ["children"], default: "", description: "The second line, such as the kind and where the item belongs." },
      { name: "slot=\"end\"", values: ["children"], default: "", description: "Quiet text at the end of the first line, such as how long ago the item arrived." }
    ],
    states: ["default", "selected", "unread", "avatar"],
    keyboard: ["The inbox moves the selection; Enter or a click picks the item."]
  };

  connectedCallback() {
    if (!this.titleElement) this.build();
    if (!this.id) this.id = uniqueId("prism-inbox-item");
    setAttribute(this, "role", "option");
    this.attributeChangedCallback();
    watchShortening(this, this.titleElement, { focusable: () => true });
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  attributeChangedCallback() {
    if (!this.titleElement) return;
    setAttribute(this, "aria-selected", String(this.hasAttribute("selected")));
    const icon = this.getAttribute("icon");
    this.tile.hidden = !icon || this.regions.start.childNodes.length > 0;
    if (icon) this.tileIcon.setAttribute("name", icon);
    setAttribute(this.tile, "data-tone", this.getAttribute("tone") || null);
  }

  build() {
    this.tile = make(this, "span", "prism-inbox-tile", { "aria-hidden": "true" });
    this.tileIcon = make(this, "prism-icon", "", { size: "sm" });
    this.tile.append(this.tileIcon);
    const start = make(this, "span", "prism-inbox-start");
    const text = make(this, "span", "prism-inbox-text");
    this.titleElement = make(this, "span", "prism-inbox-title");
    const description = make(this, "span", "prism-inbox-description");
    const end = make(this, "span", "prism-inbox-end");
    this.regions = { start, description, end };
    const place = () => {
      for (const node of [...this.childNodes]) {
        if ([this.tile, start, text, end].includes(node)) continue;
        const slot = node.nodeType === 1 ? node.getAttribute("slot") : null;
        (SLOTS.includes(slot) ? this.regions[slot] : this.titleElement).append(node);
      }
      start.hidden = start.childNodes.length === 0;
      description.hidden = description.childNodes.length === 0;
      end.hidden = end.childNodes.length === 0;
      this.attributeChangedCallback();
    };
    text.append(this.titleElement, description);
    this.append(this.tile, start, text, end);
    place();
    this.children$ = new MutationObserver(place);
    this.children$.observe(this, { childList: true });
  }

  get value() {
    return this.getAttribute("value") ?? this.titleElement?.textContent.trim() ?? "";
  }

  get selected() {
    return this.hasAttribute("selected");
  }

  set selected(on) {
    toggleAttribute(this, "selected", Boolean(on));
  }

  get tooltipText() {
    return this.titleElement?.textContent.replace(/\s+/g, " ").trim() ?? "";
  }
}
