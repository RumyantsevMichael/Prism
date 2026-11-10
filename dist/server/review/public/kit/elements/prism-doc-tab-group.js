// prism-doc-tab-group: the head of a named group of tabs in a prism-doc-tabs strip, with the group's color, name, and count; it collapses and closes the group.
// The strip places it before the group's first tab and gives each of the group's tabs the same group name and tone.
import { Base, setAttribute, shadow } from "./base.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

/** The group tones, one per color token --prism-color-group-N. */
export const GROUP_TONES = Object.freeze(["1", "2", "3", "4", "5", "6"]);

/** The tone a group name takes when none is given: the same name always takes the same tone, in every window and after a restart. */
export function groupToneOf(name) {
  let hash = 0;
  for (const character of String(name)) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return GROUP_TONES[hash % GROUP_TONES.length];
}

export class PrismDocTabGroup extends Base {
  static tag = "prism-doc-tab-group";
  static styles = ["prism-doc-tab-group.css"];
  static observedAttributes = ["collapsed", "current", "count", "tone"];
  static catalog = {
    purpose: "The head of a named group of tabs in a prism-doc-tabs strip: a colored name and a count that collapse and expand the group, and a close button for the group's tabs.",
    options: [
      { name: "name", values: ["text"], default: "", description: "The group's name, also its visible text; the strip sends it in its group events." },
      { name: "tone", values: GROUP_TONES, default: "from the name", description: "The group's color; without it, the name picks one, so a group keeps its color everywhere." },
      { name: "collapsed", values: ["boolean"], default: "false", description: "The group shows only its head and its selected tab." },
      { name: "count", values: ["number"], default: "0", description: "How many tabs the group holds, shown while it is collapsed and told to assistive technology." }
    ],
    states: ["expanded", "collapsed", "tones", "long-name"],
    keyboard: ["Inside prism-doc-tabs, arrow keys reach the head like a tab; Enter or Space collapses or expands the group.", "Tab from the focused head reaches its close button.", "Ctrl+Shift+ArrowLeft and ArrowRight, or Cmd+Shift on a Mac, move the whole group one place."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismDocTabGroup.styles, `<div class="group" part="group">
      <span class="head" part="head" role="button" tabindex="-1" aria-expanded="true"><span class="dot"></span><span class="name"><slot></slot></span><span class="count"></span></span>
      <prism-button class="close" data-action="close-group" size="sm" variant="ghost" tip="Close the group's tabs"><prism-icon name="close" size="xs"></prism-icon></prism-button>
    </div>`);
    this.head = this.root.querySelector(".head");
    this.close = this.root.querySelector(".close");
    this.countText = this.root.querySelector(".count");
  }

  connectedCallback() {
    this.sync();
    watchShortening(this, this.root.querySelector(".name"), { focusable: () => false });
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  attributeChangedCallback() {
    this.sync();
  }

  get name() {
    return this.getAttribute("name") ?? "";
  }

  get collapsed() {
    return this.hasAttribute("collapsed");
  }

  /** "close-group" for the close button, and "toggle" for the rest of the head. */
  partOf(event) {
    return event.composedPath().some((node) => node === this.close) ? "close-group" : "toggle";
  }

  focus(options) {
    this.head.focus(options);
  }

  sync() {
    if (!this.head) return;
    const count = Number(this.getAttribute("count")) || 0;
    const current = this.hasAttribute("current");
    const tabs = `${count} ${count === 1 ? "tab" : "tabs"}`;
    if (!GROUP_TONES.includes(this.getAttribute("tone"))) setAttribute(this, "tone", groupToneOf(this.name));
    setAttribute(this.head, "aria-expanded", String(!this.collapsed));
    setAttribute(this.head, "aria-label", `${this.name}, group of ${tabs}`);
    setAttribute(this.head, "tabindex", current ? "0" : "-1");
    setAttribute(this.close, "tabindex", current ? null : "-1");
    setAttribute(this.close, "label", `Close the ${tabs} of ${this.name}`);
    this.countText.textContent = this.collapsed ? String(count) : "";
  }
}
