// Generated from src/server/review/public/kit/elements/prism-empty-state.ts by scripts/native-build/compile.mjs.
import { Base, distribute, make } from "./base.js";
class PrismEmptyState extends Base {
  static tag = "prism-empty-state";
  static observedAttributes = ["heading"];
  static catalog = {
    purpose: "Says that a place has nothing to show yet, with a heading and what to do next below it.",
    options: [{ name: "heading", values: ["text"], default: "", description: "What is missing." }],
    states: ["default", "with-action"],
    keyboard: []
  };
  connectedCallback() {
    if (!this.headingElement) {
      this.headingElement = make(this, "p", "prism-empty-state-heading");
      this.body = make(this, "div", "prism-empty-state-body");
      this.prepend(this.headingElement);
      this.append(this.body);
      this.children$ = distribute(this, { default: this.body }, [this.headingElement, this.body]);
    }
    this.attributeChangedCallback();
  }
  attributeChangedCallback() {
    if (!this.headingElement) return;
    this.headingElement.textContent = this.getAttribute("heading") ?? "";
    this.headingElement.hidden = !this.getAttribute("heading");
  }
}
export {
  PrismEmptyState
};
