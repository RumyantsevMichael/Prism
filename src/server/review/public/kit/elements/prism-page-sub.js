// prism-page-sub: a line under a page's title in light DOM, such as a filter with its count, the slice a list belongs to, or why the page is settled:
// an optional leading glyph from slot="glyph", its text, which may name things in <b>, and children with slot="end", such as a link, after it.
import { Base, distribute, make } from "./base.js";

export class PrismPageSub extends Base {
  static tag = "prism-page-sub";
  static catalog = {
    purpose: "A line under a page's title that says what the page shows: a leading glyph, its text with names in bold, and a link at its end; lines that belong together stand in a .prism-page-subs group kept to the reading measure.",
    options: [
      { name: "slot=\"glyph\"", values: ["children"], default: "", description: "A glyph before the text, such as a prism-state; it is hidden from assistive technology, since the text says the same." },
      { name: "slot=\"end\"", values: ["children"], default: "", description: "Content after the text, such as a link back to the whole list." },
      { name: "detail", values: ["boolean"], default: "false", description: "A quieter, smaller line, such as the reason of a decision under the line that names it." }
    ],
    states: ["default", "with-link", "with-glyph", "detail", "group"],
    keyboard: ["A link in the line is reached by Tab."]
  };

  connectedCallback() {
    if (!this.text$) {
      this.glyph$ = make(this, "span", "prism-page-sub-glyph", { "aria-hidden": "true" });
      this.text$ = make(this, "span", "prism-page-sub-text");
      this.end$ = make(this, "span", "prism-page-sub-end");
      this.append(this.glyph$, this.text$, this.end$);
      const regions = { glyph: this.glyph$, default: this.text$, end: this.end$ };
      const own = [this.glyph$, this.text$, this.end$];
      const place = () => {
        this.glyph$.hidden = this.glyph$.childNodes.length === 0;
      };
      this.children$ = distribute(this, regions, own);
      this.glyphs$ = new MutationObserver(place);
      this.glyphs$.observe(this.glyph$, { childList: true });
      place();
    }
  }
}
