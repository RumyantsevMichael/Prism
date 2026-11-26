// Generated from src/server/review/public/kit/elements/prism-place-head.ts by scripts/native-build/compile.mjs.
import { Base, make, setAttribute, uniqueId } from "./base.js";
import { remeasure, unwatchShortening, watchShortening } from "../shorten.js";
class PrismPlaceHead extends Base {
  static tag = "prism-place-head";
  static observedAttributes = ["heading", "subtitle"];
  static catalog = {
    purpose: "The head of a place's sidebar: one line on the tab strip's line with the place's title as a level 2 heading and room at its end for a control, such as the button that hides the sidebar.",
    options: [
      { name: "heading", values: ["text"], default: "", description: "The place's title, a level 2 heading; it ends with an ellipsis when it does not fit, and the tooltip shows it whole." },
      { name: "subtitle", values: ["text"], default: "", description: "What the place holds, shown in the title's tooltip after the title and given as the title's visually hidden description in the same words." },
      { name: 'slot="end"', values: ["children"], default: "", description: "Controls at the head's end, such as the button that hides the sidebar." }
    ],
    states: ["default", "no-subtitle", "end", "long-text", "unbroken-name"],
    keyboard: ["The head is not a control; a shortened title joins the Tab order so its full text can be read.", "Controls in the end slot keep their own keys."]
  };
  connectedCallback() {
    if (!this.title$) this.build();
    this.sync();
    watchShortening(this.title$, this.title$);
  }
  disconnectedCallback() {
    unwatchShortening(this.title$);
  }
  attributeChangedCallback() {
    if (this.title$) this.sync();
  }
  build() {
    this.title$ = make(this, "h2", "prism-place-head-title");
    this.end$ = make(this, "span", "prism-place-head-end");
    this.description$ = make(this, "span", "sr-only", { id: uniqueId("prism-place-head-description") });
    const place = () => {
      for (const node of [...this.childNodes]) {
        if (node === this.title$ || node === this.end$ || node === this.description$) continue;
        if (node.nodeType === 1 && node.getAttribute("slot") === "end") this.end$.append(node);
        else node.remove();
      }
      this.end$.hidden = !this.end$.childElementCount;
    };
    place();
    this.prepend(this.title$, this.description$, this.end$);
    this.children$ = new MutationObserver(place);
    this.children$.observe(this, { childList: true });
  }
  sync() {
    const heading = this.getAttribute("heading") ?? "";
    const subtitle = this.getAttribute("subtitle") ?? "";
    if (this.title$.textContent !== heading) {
      this.title$.textContent = heading;
      remeasure(this.title$);
    }
    const tip = subtitle ? `${heading}: ${subtitle}` : heading;
    for (const node of [this, this.title$]) if (node.getAttribute("tip") !== tip) node.setAttribute("tip", tip);
    const description = this.description$;
    if (description.textContent !== (subtitle ? tip : "")) description.textContent = subtitle ? tip : "";
    const described = (this.title$.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== description.id);
    if (subtitle) described.unshift(description.id);
    setAttribute(this.title$, "aria-describedby", described.length ? described.join(" ") : null);
  }
}
export {
  PrismPlaceHead
};
