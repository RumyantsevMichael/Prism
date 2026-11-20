// prism-place-head: the head of a place's sidebar in light DOM: one line on the tab strip's line with the place's title as a level 2 heading and, at its end, children with slot="end", such as the button that hides the sidebar.
// The subtitle says what the place holds in the title's tooltip, since the rows below already show it.
import { Base, make } from "./base.js";
import { remeasure, unwatchShortening, watchShortening } from "../shorten.js";

export class PrismPlaceHead extends Base {
  static tag = "prism-place-head";
  static observedAttributes = ["heading", "subtitle"];
  static catalog = {
    purpose: "The head of a place's sidebar: one line on the tab strip's line with the place's title as a level 2 heading and room at its end for a control, such as the button that hides the sidebar.",
    options: [
      { name: "heading", values: ["text"], default: "", description: "The place's title, a level 2 heading; it ends with an ellipsis when it does not fit, and the tooltip shows it whole." },
      { name: "subtitle", values: ["text"], default: "", description: "What the place holds, shown in the title's tooltip after the title." },
      { name: "slot=\"end\"", values: ["children"], default: "", description: "Controls at the head's end, such as the button that hides the sidebar." }
    ],
    states: ["default", "no-subtitle", "end", "long-text", "unbroken-name"],
    keyboard: ["The head is not a control; a shortened title joins the Tab order so its full text can be read.", "Controls in the end slot keep their own keys."]
  };

  connectedCallback() {
    if (!(this as any).title$) this.build();
    this.sync();
    watchShortening((this as any).title$, (this as any).title$);
  }

  disconnectedCallback() {
    unwatchShortening((this as any).title$);
  }

  attributeChangedCallback() {
    if ((this as any).title$) this.sync();
  }

  build() {
    (this as any).title$ = make(this, "h2", "prism-place-head-title");
    (this as any).end$ = make(this, "span", "prism-place-head-end");
    const place = () => {
      for (const node of [...this.childNodes]) {
        if (node === (this as any).title$ || node === (this as any).end$) continue;
        if (node.nodeType === 1 && (node as any).getAttribute("slot") === "end") (this as any).end$.append(node);
        else node.remove();
      }
      (this as any).end$.hidden = !(this as any).end$.childElementCount;
    };
    place();
    this.prepend((this as any).title$, (this as any).end$);
    (this as any).children$ = new MutationObserver(place);
    (this as any).children$.observe(this, { childList: true });
  }

  sync() {
    const heading = this.getAttribute("heading") ?? "";
    const subtitle = this.getAttribute("subtitle") ?? "";
    if ((this as any).title$.textContent !== heading) {
      (this as any).title$.textContent = heading;
      remeasure((this as any).title$);
    }
    const tip = subtitle ? `${heading}: ${subtitle}` : heading;
    // The head names the place and what it holds on hover over its title, and the title says the same when it is shortened.
    for (const node of [this, (this as any).title$]) if (node.getAttribute("tip") !== tip) node.setAttribute("tip", tip);
  }
}
