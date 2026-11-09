// prism-list-item: one option of a prism-listbox in light DOM: its text on one line, and children with slot="meta" after it as the option's kind.
import { Base, make, setAttribute, toggleAttribute, uniqueId } from "./base.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

export class PrismListItem extends Base {
  static tag = "prism-list-item";
  static tooltipBoundary = true;
  static observedAttributes = ["selected", "active"];
  static catalog = {
    purpose: "One option of a prism-listbox: its text on one line and its kind from children with slot=\"meta\".",
    options: [
      { name: "value", values: ["text"], default: "", description: "The value the listbox sends in prism-select." },
      { name: "selected", values: ["boolean"], default: "false", description: "Whether it is the chosen option; exposed as aria-selected." },
      { name: "slot=\"meta\"", values: ["children"], default: "", description: "Quieter text after the option, such as its kind." }
    ],
    states: ["default", "active", "selected", "meta"],
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
    this.labelElement = make(this, "span", "prism-list-label");
    this.metaElement = make(this, "span", "prism-list-meta");
    const place = () => {
      for (const node of [...this.childNodes]) {
        if (node === this.labelElement || node === this.metaElement) continue;
        if (node.nodeType === 1 && node.getAttribute("slot") === "meta") this.metaElement.append(node);
        else this.labelElement.append(node);
      }
      this.metaElement.hidden = this.metaElement.childNodes.length === 0;
    };
    this.append(this.labelElement, this.metaElement);
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
