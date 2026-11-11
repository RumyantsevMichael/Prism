// prism-rail: the icon rail at the window's start edge that switches between places, as a navigation landmark, in light DOM.
// It holds a head block for children with slot="head", such as the sidebar button, ended by a pale separator, then its prism-rail-item children, then children with slot="foot" at its far end.
// The head block is as tall as a strip of document tabs over a page bar, so it lines up with the main island beside the rail; without head children the rail has no head block.
import { Base, deepActiveElement, make, setAttribute } from "./base.js";

export class PrismRail extends Base {
  static tag = "prism-rail";
  static observedAttributes = ["label"];
  static catalog = {
    purpose: "The icon rail at the window's start edge that switches between places: a navigation landmark with a head block for the sidebar button, one button per place, and a foot for later items.",
    options: [
      { name: "label", values: ["text"], default: "Places", description: "The navigation landmark's accessible name." },
      { name: "prism-rail-item children", values: ["children"], default: "", description: "One button per place, in order." },
      { name: "slot=\"head\"", values: ["children"], default: "", description: "Controls in the head block, such as the sidebar button; the head block is as tall as a strip of document tabs over a page bar and a separator in the line color ends it. Without head children the rail starts with its places." },
      { name: "slot=\"foot\"", values: ["children"], default: "", description: "Items at the far end of the rail, below the places." }
    ],
    states: ["default", "head", "collapsed", "many-places", "long-text", "unbroken-name"],
    keyboard: ["Each button is in the Tab order.", "ArrowDown and ArrowUp move focus to the next and previous button of the rail; Home and End move to the first and last."]
  };

  constructor() {
    super();
    this.addEventListener("keydown", (event) => this.onKey(event));
  }

  connectedCallback() {
    if (!this.nav) this.build();
    this.sync();
  }

  attributeChangedCallback() {
    if (this.nav) this.sync();
  }

  build() {
    this.nav = make(this, "nav", "prism-rail-nav");
    this.head = make(this, "div", "prism-rail-head");
    this.headContent = make(this, "div", "prism-rail-head-content");
    this.rule = make(this, "span", "prism-rail-rule", { role: "separator" });
    this.head.append(this.headContent, this.rule);
    this.places = make(this, "div", "prism-rail-places");
    this.foot = make(this, "div", "prism-rail-foot");
    this.nav.append(this.head, this.places, this.foot);
    this.prepend(this.nav);
    // Head and foot children go to their blocks, every other element to the places; text stays out of the rail.
    const place = () => {
      for (const node of [...this.childNodes]) {
        if (node === this.nav) continue;
        const slot = node.nodeType === 1 ? node.getAttribute("slot") : null;
        if (slot === "head") this.headContent.append(node);
        else if (slot === "foot") this.foot.append(node);
        else if (node.nodeType === 1) this.places.append(node);
        else node.remove();
      }
      this.sync();
    };
    place();
    this.children$ = new MutationObserver(place);
    this.children$.observe(this, { childList: true });
    this.blocks$ = new MutationObserver(() => this.sync());
    for (const block of [this.headContent, this.foot]) this.blocks$.observe(block, { childList: true });
  }

  sync() {
    setAttribute(this.nav, "aria-label", this.getAttribute("label") || "Places");
    const hasHead = this.headContent.children.length > 0;
    this.head.hidden = !hasHead;
    this.nav.classList.toggle("has-head", hasHead);
    this.foot.hidden = this.foot.children.length === 0;
  }

  /** The rail's buttons in order, head, places, and foot, leaving out hidden ones. */
  get buttons() {
    return [...this.nav.querySelectorAll("button")].filter((button) => !button.disabled && button.getClientRects().length > 0);
  }

  onKey(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = this.buttons;
    if (!buttons.length) return;
    const active = deepActiveElement(this.ownerDocument);
    const at = buttons.findIndex((button) => button === active || button.contains(active));
    let next;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (at === -1) next = 0;
    else next = (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next].focus();
  }
}
