// prism-rail-item: one button of a prism-rail in light DOM: an icon, a pressed state for the current place, a count badge on its corner, and its label as its tooltip.
// Its accessible name is its label, followed by the count in words when it shows one, such as "Attention, 3 questions".
import { Base, emit, make, setAttribute } from "./base.js";

// Attributes a page sets on the item that reach its native button, such as the sidebar button's expanded state.
const FORWARDED = ["aria-expanded", "aria-controls", "aria-keyshortcuts"];
// The largest count the badge draws whole; a larger one shows as this number and a plus, and the accessible name and tooltip carry it whole.
const MAX_SHOWN = 99;

export class PrismRailItem extends Base {
  static tag = "prism-rail-item";
  static observedAttributes = ["label", "icon", "pressed", "count", "count-label", "tip", "size", ...FORWARDED];
  static catalog = {
    purpose: "One button of the rail: a place, or the sidebar button, drawn as an icon whose label is its tooltip, with a pressed state for the current place and a count badge on its corner.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The button's name, which the tooltip shows unless tip says more." },
      { name: "icon", values: ["prism-icon name"], default: "", description: "The glyph the button shows." },
      { name: "value", values: ["text"], default: "", description: "The value the item sends in prism-select when it is chosen." },
      { name: "pressed", values: ["boolean", "false"], default: "", description: "Makes it a toggle and exposes the state as aria-pressed; the current place is pressed and paints the selected color with an accent bar at its start." },
      { name: "count", values: ["number"], default: "", description: "A count on the button's top end corner; 0 or none shows no badge, two or more digits draw a small badge, and over 99 shows 99+ with the whole count in the accessible name and the tooltip." },
      { name: "count-label", values: ["text"], default: "", description: "The count in words, added to the accessible name after a comma while the badge shows, such as 3 questions." },
      { name: "tip", values: ["text"], default: "", description: "The tooltip's text on hover and keyboard focus, when it should say more than the label, such as the key that runs it." },
      { name: "size", values: ["md", "sm"], default: "md", description: "md is a rail button; sm draws the same button at --prism-control-height with a small count, as the top bar's Attention bell does while the rail is hidden." }
    ],
    states: ["default", "pressed", "count", "toggle", "small", "long-text", "unbroken-name"],
    keyboard: ["Enter and Space choose the item and send prism-select with detail.value.", "A Ctrl or Cmd click sends prism-select with detail.keep true, so the page can open a kept tab.", "Keyboard focus shows its tooltip at once."]
  };

  connectedCallback() {
    if (!this.button) this.build();
    this.sync();
  }

  attributeChangedCallback(name) {
    // A tip the page sets says more than the label and stays; one the item set follows its label.
    if (name === "tip" && !this.settingTip) this.tipFromLabel = false;
    if (this.button) this.sync();
  }

  build() {
    this.button = make(this, "button", "prism-rail-button", { type: "button" });
    this.icon = make(this, "prism-icon", "prism-rail-icon", { "aria-hidden": "true" });
    this.badge = make(this, "prism-badge", "prism-rail-badge", { solid: "", "aria-hidden": "true" });
    this.button.append(this.icon, this.badge);
    this.replaceChildren(this.button);
    // A Ctrl or Cmd click asks for a kept tab, as it does on a link of the sidebar.
    this.button.addEventListener("click", (event) => emit(this, "prism-select", { value: this.value, keep: event.ctrlKey || event.metaKey }));
  }

  get value() {
    return this.getAttribute("value") ?? this.getAttribute("label") ?? "";
  }

  get pressed() {
    return this.hasAttribute("pressed") && this.getAttribute("pressed") !== "false";
  }

  get count() {
    const count = Number.parseInt(this.getAttribute("count") ?? "", 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  focus(options) {
    this.button?.focus(options);
  }

  click() {
    this.button?.click();
  }

  sync() {
    const label = this.getAttribute("label") ?? "";
    const count = this.count;
    const words = this.getAttribute("count-label") || String(count);
    setAttribute(this.button, "aria-label", count ? `${label}, ${words}` : label || null);
    setAttribute(this.button, "aria-pressed", this.hasAttribute("pressed") ? String(this.pressed) : null);
    for (const name of FORWARDED) setAttribute(this.button, name, this.getAttribute(name));
    setAttribute(this.icon, "name", this.getAttribute("icon") || null);
    // A count of two or more digits draws the small badge, and one over 99 shows 99+, so the badge stays on the corner and the glyph stays readable.
    setAttribute(this.badge, "size", this.getAttribute("size") === "sm" || count > 9 ? "sm" : null);
    this.badge.hidden = count === 0;
    const shown = count > MAX_SHOWN ? `${MAX_SHOWN}+` : count ? String(count) : "";
    if (this.badge.textContent !== shown) this.badge.textContent = shown;
    // The kit tooltip reads the item's tip, so the label stands in when no tip says more, with the whole count when the badge caps it.
    const tip = label && count > MAX_SHOWN ? `${label}, ${words}` : label;
    if ((!this.hasAttribute("tip") || this.tipFromLabel) && this.getAttribute("tip") !== tip) {
      this.settingTip = true;
      setAttribute(this, "tip", tip || null);
      this.settingTip = false;
      this.tipFromLabel = true;
    }
  }
}
