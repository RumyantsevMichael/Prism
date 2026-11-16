// prism-choice: a named radio group of prism-choice-option elements, each a native radio input, reporting the chosen value;
// with multiple, a group of native checkboxes that reports every chosen value.
import { Base, setAttribute, uniqueId } from "./base.js";

export class PrismChoice extends Base {
  static tag = "prism-choice";
  static observedAttributes = ["label", "value", "multiple"];
  static catalog = {
    purpose: "A radio group of options with titles and descriptions; the native radios move with the arrow keys and report change after the value updates. With multiple it is a group of checkboxes, each toggled with Space, whose values property lists every chosen value.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The group's visible name and accessible name." },
      { name: "name", values: ["text"], default: "", description: "The radios' name in their form." },
      { name: "value", values: ["text"], default: "", description: "The chosen option's value; the value property reads and writes it. With multiple, the values property reads and writes the list of chosen values." },
      { name: "multiple", values: ["boolean"], default: "false", description: "Lets the person choose several options, each a native checkbox." }
    ],
    states: ["unchosen", "chosen", "with-detail", "multiple"],
    keyboard: ["Tab reaches the chosen option, or the first one when none is chosen; with multiple, Tab reaches every enabled option in turn.", "The arrow keys move the choice to the next or previous enabled option and send change; with multiple, Space chooses or clears the focused option and sends change."]
  };

  constructor() {
    super();
    this.addEventListener("change", () => {
      this.touched = true;
    });
  }

  connectedCallback() {
    setAttribute(this, "role", this.multiple ? "group" : "radiogroup");
    if (!this.heading) {
      this.heading = this.ownerDocument.createElement("div");
      this.heading.className = "prism-choice-label";
      this.heading.id = uniqueId("prism-choice-label");
      this.prepend(this.heading);
    }
    this.attributeChangedCallback("label");
    if (this.hasAttribute("value")) this.value = this.getAttribute("value");
  }

  attributeChangedCallback(name, previous, next) {
    if (!this.heading) return;
    if (name === "multiple") {
      setAttribute(this, "role", this.multiple ? "group" : "radiogroup");
      for (const option of this.querySelectorAll("prism-choice-option")) option.sync?.();
      return;
    }
    if (name === "value" && next !== null) {
      this.value = next;
      return;
    }
    const label = this.getAttribute("label") ?? "";
    this.heading.textContent = label;
    this.heading.hidden = !label;
    setAttribute(this, "aria-labelledby", label ? this.heading.id : null);
  }

  get inputs() {
    return [...this.querySelectorAll("input.prism-choice-input")];
  }

  get multiple() {
    return this.hasAttribute("multiple");
  }

  get value() {
    return this.inputs.find((input) => input.checked)?.value ?? "";
  }

  set value(value) {
    for (const input of this.inputs) input.checked = input.value === String(value);
  }

  /** Every chosen value in option order, for a choice of several options. */
  get values() {
    return this.inputs.filter((input) => input.checked).map((input) => input.value);
  }

  set values(values) {
    const chosen = new Set([...(values ?? [])].map(String));
    for (const input of this.inputs) input.checked = chosen.has(input.value);
  }
}
