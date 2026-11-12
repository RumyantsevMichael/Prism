// prism-disclosure: a toggle button with its summary that shows or hides the content below it, in light DOM.
import { Base, distribute, make, setAttribute, toggleAttribute, uniqueId } from "./base.js";

export class PrismDisclosure extends Base {
  static tag = "prism-disclosure";
  static observedAttributes = ["summary", "open"];
  static catalog = {
    purpose: "A summary that shows or hides the content below it, such as a record's raw text or earlier runs.",
    options: [
      { name: "summary", values: ["text"], default: "", description: "The toggle's text, which names it." },
      { name: "open", values: ["boolean"], default: "false", description: "Whether the content shows; the element sends toggle with detail.open when it changes." }
    ],
    states: ["closed", "open"],
    keyboard: ["Enter, Space, or a click on the toggle opens or closes the content; the toggle exposes aria-expanded."]
  };

  connectedCallback() {
    if (!this.toggle) this.build();
    this.sync();
  }

  attributeChangedCallback(name, previous, next) {
    if (!this.toggle) return;
    this.sync();
    if (name === "open" && (previous === null) !== (next === null)) this.dispatchEvent(new CustomEvent("toggle", { detail: { open: this.open } }));
  }

  build() {
    const id = uniqueId("prism-disclosure");
    this.toggle = make(this, "button", "prism-disclosure-toggle", { type: "button", "aria-controls": `${id}-body` });
    this.icon = make(this, "prism-icon", "", { name: "chevron-right", size: "xs" });
    this.summaryElement = make(this, "span", "prism-disclosure-summary");
    this.toggle.append(this.icon, this.summaryElement);
    this.toggle.addEventListener("click", () => (this.open = !this.open));
    this.body = make(this, "div", "prism-disclosure-body", { id: `${id}-body` });
    this.prepend(this.toggle);
    this.append(this.body);
    this.children$ = distribute(this, { default: this.body }, [this.toggle, this.body]);
  }

  get open() {
    return this.hasAttribute("open");
  }

  set open(on) {
    toggleAttribute(this, "open", Boolean(on));
  }

  sync() {
    this.summaryElement.textContent = this.getAttribute("summary") ?? "";
    setAttribute(this.toggle, "aria-expanded", String(this.open));
    setAttribute(this.icon, "name", this.open ? "chevron-down" : "chevron-right");
    this.body.hidden = !this.open;
  }
}
