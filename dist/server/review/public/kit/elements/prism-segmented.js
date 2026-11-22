// Generated from src/server/review/public/kit/elements/prism-segmented.ts by scripts/native-build/compile.mjs.
import { Base, emit, setAttribute, uniqueId } from "./base.js";
class PrismSegmented extends Base {
  static tag = "prism-segmented";
  static observedAttributes = ["label", "value", "disabled"];
  static catalog = {
    purpose: "A choice of a few views or modes drawn as one segmented switch, such as the Roadmap's Board, List, and Graph; each segment is a native button with the radio role.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The group's accessible name." },
      { name: "value", values: ["text"], default: "", description: "The chosen segment's value; the value property reads and writes it." },
      { name: "disabled", values: ["boolean"], default: "false", description: "Every segment is disabled: the chosen one still shows the value, and no click or key changes it, for a choice the page can show but not offer." },
      { name: "wrap", values: ["boolean"], default: "false", description: "Segments that no longer fit on one line go on to the next line with their whole words, for a choice of several filters with counts." },
      { name: "children with value", values: ["children"], default: "", description: "Each child that carries a value attribute becomes one segment showing the child's content." }
    ],
    states: ["default", "chosen", "disabled", "wrap", "long-text", "unbroken-name"],
    keyboard: ["Tab reaches the chosen segment, and skips a disabled choice.", "ArrowLeft and ArrowRight, or ArrowUp and ArrowDown, choose the previous or next segment, wrapping at the ends.", "Enter, Space, or a click chooses a segment and sends change with detail.value."]
  };
  connectedCallback() {
    setAttribute(this, "role", "radiogroup");
    this.build();
    this.sync();
    if (!this.listening) {
      this.listening = true;
      this.addEventListener("click", (event) => {
        const segment = event.target.closest?.(".prism-segment");
        if (segment && this.contains(segment)) this.choose(segment.dataset.value);
      });
      this.addEventListener("keydown", (event) => this.move(event));
    }
  }
  attributeChangedCallback() {
    this.sync();
  }
  get segments() {
    return [...this.querySelectorAll(":scope > .prism-segment")];
  }
  get value() {
    return this.getAttribute("value") ?? "";
  }
  set value(value) {
    this.setAttribute("value", String(value));
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(value) {
    this.toggleAttribute("disabled", Boolean(value));
  }
  // Turns each child with a value attribute into a segment button that holds the child's content.
  build() {
    for (const child of [...this.children]) {
      if (child.classList.contains("prism-segment") || !child.hasAttribute("value")) continue;
      const button = this.ownerDocument.createElement("button");
      button.type = "button";
      button.className = "prism-segment";
      button.id = uniqueId("prism-segment");
      button.dataset.value = child.getAttribute("value");
      button.setAttribute("role", "radio");
      const text = this.ownerDocument.createElement("span");
      text.className = "prism-segment-text";
      text.append(...child.childNodes);
      button.append(text);
      child.replaceWith(button);
    }
  }
  sync() {
    setAttribute(this, "aria-label", this.getAttribute("label") || null);
    const disabled = this.disabled;
    setAttribute(this, "aria-disabled", disabled ? "true" : null);
    const segments = this.segments;
    const chosen = segments.find((segment) => segment.dataset.value === this.value) ?? null;
    for (const segment of segments) {
      const on = segment === chosen;
      setAttribute(segment, "aria-checked", String(on));
      segment.disabled = disabled;
      segment.tabIndex = on || !chosen && segment === segments[0] ? 0 : -1;
    }
  }
  choose(value) {
    if (value === void 0 || value === this.value || this.disabled) return;
    this.value = value;
    emit(this, "change", { value });
  }
  move(event) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step || this.disabled) return;
    const segments = this.segments;
    if (!segments.length) return;
    event.preventDefault();
    const at = segments.findIndex((segment) => segment.dataset.value === this.value);
    const next = segments[(Math.max(at, 0) + step + segments.length) % segments.length];
    this.choose(next.dataset.value);
    next.focus();
  }
}
export {
  PrismSegmented
};
