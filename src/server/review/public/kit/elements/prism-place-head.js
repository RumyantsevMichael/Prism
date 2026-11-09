// prism-place-head: the head of a place's sidebar in light DOM: the place's title as a level 2 heading over its subtitle.
// The title stands on the line of a strip of document tabs and the subtitle on the line of a page bar, so the head lines up with the main island beside the sidebar.
import { Base, make } from "./base.js";
import { remeasure, unwatchShortening, watchShortening } from "../shorten.js";

export class PrismPlaceHead extends Base {
  static tag = "prism-place-head";
  static observedAttributes = ["heading", "subtitle"];
  static catalog = {
    purpose: "The head of a place's sidebar: the place's title as a level 2 heading, with a subtitle that says what the place holds, lined up with the tab strip and the page bar beside it.",
    options: [
      { name: "heading", values: ["text"], default: "", description: "The place's title, a level 2 heading on the tab strip's line; it ends with an ellipsis when it does not fit, and the tooltip shows it whole." },
      { name: "subtitle", values: ["text"], default: "", description: "What the place holds, in muted small text on the page bar's line; it ends with an ellipsis when it does not fit." }
    ],
    states: ["default", "no-subtitle", "long-text", "unbroken-name"],
    keyboard: ["The head is not a control; a shortened title or subtitle joins the Tab order so its full text can be read."]
  };

  connectedCallback() {
    if (!this.title$) this.build();
    this.sync();
    watchShortening(this.title$, this.title$);
    watchShortening(this.subtitle$, this.subtitle$);
  }

  disconnectedCallback() {
    unwatchShortening(this.title$);
    unwatchShortening(this.subtitle$);
  }

  attributeChangedCallback() {
    if (this.title$) this.sync();
  }

  build() {
    this.title$ = make(this, "h2", "prism-place-head-title");
    this.subtitle$ = make(this, "span", "prism-place-head-subtitle");
    this.replaceChildren(this.title$, this.subtitle$);
  }

  sync() {
    const heading = this.getAttribute("heading") ?? "";
    const subtitle = this.getAttribute("subtitle") ?? "";
    if (this.title$.textContent !== heading) {
      this.title$.textContent = heading;
      remeasure(this.title$);
    }
    if (this.subtitle$.textContent !== subtitle) {
      this.subtitle$.textContent = subtitle;
      remeasure(this.subtitle$);
    }
    this.subtitle$.hidden = !subtitle;
  }
}
