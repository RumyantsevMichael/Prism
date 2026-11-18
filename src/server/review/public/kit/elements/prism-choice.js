// prism-choice: a named radio group of prism-choice-option elements, each a native radio input, reporting the chosen value.
import { Base, setAttribute, uniqueId } from "./base.js";

export class PrismChoice extends Base {
  static tag = "prism-choice";
  static observedAttributes = ["label", "value"];
  static catalog = {
    purpose: "A radio group of options with titles and descriptions; the native radios move with the arrow keys and report change after the value updates.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The group's visible name and accessible name." },
      { name: "name", values: ["text"], default: "", description: "The radios' name in their form." },
      { name: "value", values: ["text"], default: "", description: "The chosen option's value; the value property reads and writes it." },
      { name: "clearable", values: ["boolean"], default: "false", description: "Choosing the chosen option again, by click or Space, leaves nothing chosen and sends change, as clear() does, so an answer can go back to none." }
    ],
    states: ["unchosen", "chosen", "with-detail", "clearable"],
    keyboard: ["Tab reaches the chosen option, or the first one when none is chosen.", "The arrow keys move the choice to the next or previous enabled option and send change.", "In a clearable choice, Space on the chosen option leaves nothing chosen and sends change."]
  };

  constructor() {
    super();
    this.addEventListener("change", () => {
      this.touched = true;
    });
    // A radio that was already chosen when the pointer went down is unchosen by that click in a clearable choice; a native radio ignores it.
    this.addEventListener("pointerdown", (event) => this.noteChosen(event.target));
    // A native radio ignores Space once it is chosen, so a clearable choice unchooses it here.
    this.addEventListener("keydown", (event) => {
      this.chosenAtStart = null;
      if (event.key !== " " || !this.hasAttribute("clearable")) return;
      this.noteChosen(event.target);
      if (!this.chosenAtStart) return;
      event.preventDefault();
      this.chosenAtStart = null;
      this.clear();
    });
    this.addEventListener("click", (event) => {
      const input = event.target;
      const unchoose = this.hasAttribute("clearable") && input === this.chosenAtStart && input.checked;
      this.chosenAtStart = null;
      if (unchoose) this.clear();
    });
  }

  noteChosen(target) {
    this.chosenAtStart = target instanceof HTMLInputElement && target.classList.contains("prism-choice-input") && target.checked ? target : null;
  }

  /** Leaves no option chosen and sends change when one was. */
  clear() {
    const chosen = this.inputs.find((input) => input.checked);
    if (!chosen) return;
    chosen.checked = false;
    this.dispatchEvent(new Event("change", { bubbles: true }));
  }

  connectedCallback() {
    setAttribute(this, "role", "radiogroup");
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

  get value() {
    return this.inputs.find((input) => input.checked)?.value ?? "";
  }

  set value(value) {
    for (const input of this.inputs) input.checked = input.value === String(value);
  }
}
