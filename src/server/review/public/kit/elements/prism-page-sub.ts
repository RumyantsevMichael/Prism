// prism-page-sub: a line under a page's title in light DOM, such as a filter with its count, the slice a list belongs to, or why the page is settled:
// an optional leading glyph from slot="glyph", its text, which may name things in <b>, and children with slot="end", such as a link, after it.
import { Base, distribute, make } from "./base.js";

export class PrismPageSub extends Base {
  static tag = "prism-page-sub";
  static catalog = {
    purpose: "A line under a page's title that says what the page shows: a leading glyph, its text with names in bold, and a link at its end; lines that belong together stand in a .prism-page-subs group kept to the reading measure.",
    options: [
      { name: "slot=\"glyph\"", values: ["children"], default: "", description: "A glyph before the text, such as a prism-status; it is hidden from assistive technology, since the text says the same." },
      { name: "slot=\"end\"", values: ["children"], default: "", description: "Content after the text, such as a link back to the whole list." },
      { name: "detail", values: ["boolean"], default: "false", description: "A quieter, smaller line, such as the reason of a decision under the line that names it." }
    ],
    states: ["default", "with-link", "with-glyph", "detail", "group"],
    keyboard: ["A link in the line is reached by Tab."]
  };

  connectedCallback() {
    if (!(this as any).text$) {
      (this as any).glyph$ = make(this, "span", "prism-page-sub-glyph", { "aria-hidden": "true" });
      (this as any).text$ = make(this, "span", "prism-page-sub-text");
      (this as any).end$ = make(this, "span", "prism-page-sub-end");
      this.append((this as any).glyph$, (this as any).text$, (this as any).end$);
      const regions = { glyph: (this as any).glyph$, default: (this as any).text$, end: (this as any).end$ };
      const own = [(this as any).glyph$, (this as any).text$, (this as any).end$];
      const place = () => {
        (this as any).glyph$.hidden = (this as any).glyph$.childNodes.length === 0;
      };
      (this as any).children$ = distribute(this, regions, (own as any));
      (this as any).glyphs$ = new MutationObserver(place);
      (this as any).glyphs$.observe((this as any).glyph$, { childList: true });
      place();
    }
  }
}
