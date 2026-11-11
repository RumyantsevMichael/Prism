// prism-list-item: one option of a prism-listbox in light DOM: its text on one line, children with slot="meta" after it as the option's kind,
// and, for a two-line option, a leading icon from slot="icon" and a second line from slot="detail".
import { Base, make, setAttribute, toggleAttribute, uniqueId } from "./base.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

export class PrismListItem extends Base {
  static tag = "prism-list-item";
  static tooltipBoundary = true;
  static observedAttributes = ["selected", "active", "current"];
  static catalog = {
    purpose: "One option of a prism-listbox: its text on one line and its kind from children with slot=\"meta\"; with a detail it reads as two lines beside an icon, and a <mark> in its text highlights a match.",
    options: [
      { name: "value", values: ["text"], default: "", description: "The value the listbox sends in prism-select." },
      { name: "selected", values: ["boolean"], default: "false", description: "Whether it is the chosen option; exposed as aria-selected." },
      { name: "slot=\"meta\"", values: ["children"], default: "", description: "Quieter text after the option, such as its kind." },
      { name: "slot=\"icon\"", values: ["children"], default: "", description: "A prism-icon before the option's text, which takes the accent while the option is active." },
      { name: "slot=\"detail\"", values: ["children"], default: "", description: "A quieter second line under the option's text, such as where a result belongs." },
      { name: "current", values: ["boolean"], default: "false", description: "Shows the option as the one Enter would choose while no option is active; a listbox with first-current sets it." }
    ],
    states: ["default", "active", "selected", "meta", "two-line", "highlight"],
    keyboard: ["The listbox moves the active option; Enter or a click chooses it."]
  };

  connectedCallback() {
    if (!this.labelElement) this.build();
    if (!this.id) this.id = uniqueId("prism-option");
    setAttribute(this, "role", "option");
    this.attributeChangedCallback();
    watchShortening(this, this.labelElement, { focusable: () => true });
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  attributeChangedCallback() {
    setAttribute(this, "aria-selected", String(this.hasAttribute("selected")));
  }

  build() {
    this.iconElement = make(this, "span", "prism-list-icon");
    this.labelElement = make(this, "span", "prism-list-label");
    this.metaElement = make(this, "span", "prism-list-meta");
    this.detailElement = make(this, "span", "prism-list-detail");
    const regions = { icon: this.iconElement, meta: this.metaElement, detail: this.detailElement };
    const own = new Set(Object.values(regions).concat(this.labelElement));
    const place = () => {
      for (const node of [...this.childNodes]) {
        if (own.has(node)) continue;
        const slot = node.nodeType === 1 ? node.getAttribute("slot") : null;
        (regions[slot] ?? this.labelElement).append(node);
      }
      for (const region of Object.values(regions)) region.hidden = region.childNodes.length === 0;
      toggleAttribute(this, "two-line", !this.detailElement.hidden);
    };
    this.append(this.iconElement, this.labelElement, this.metaElement, this.detailElement);
    place();
    this.children$ = new MutationObserver(place);
    this.children$.observe(this, { childList: true });
  }

  get value() {
    return this.getAttribute("value") ?? this.labelElement?.textContent.trim() ?? "";
  }

  get selected() {
    return this.hasAttribute("selected");
  }

  set selected(on) {
    toggleAttribute(this, "selected", Boolean(on));
  }

  get tooltipText() {
    return this.textContent.replace(/\s+/g, " ").trim();
  }
}
