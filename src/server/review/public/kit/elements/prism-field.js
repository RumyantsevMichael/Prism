// prism-field: a labelled native text, search, textarea, or select control in the light DOM, with a hint and an error message.
import { Base, setAttribute, uniqueId } from "./base.js";

const TYPES = ["text", "search", "textarea", "select"];

export class PrismField extends Base {
  static tag = "prism-field";
  static observedAttributes = ["label", "hint", "name", "value", "placeholder", "required", "disabled", "invalid", "error", "type"];
  static catalog = {
    purpose: "A labelled text, search, textarea, or select control: one native control in the light DOM, so it belongs to its form and reports input and change.",
    options: [
      { name: "type", values: TYPES, default: "text", description: "The kind of native control the field creates." },
      { name: "label", values: ["text"], default: "", description: "The visible label, associated with the control." },
      { name: "hint", values: ["text"], default: "", description: "Help text below the control, linked as its description." },
      { name: "name", values: ["text"], default: "", description: "The control's name in its form." },
      { name: "value", values: ["text"], default: "", description: "The starting value; the value property reads and writes the control." },
      { name: "placeholder", values: ["text"], default: "", description: "Text shown while a text control is empty." },
      { name: "required", values: ["boolean"], default: "false", description: "The control must hold a value." },
      { name: "disabled", values: ["boolean"], default: "false", description: "The control takes no input." },
      { name: "invalid", values: ["boolean"], default: "false", description: "Marks the value as wrong, exposed as aria-invalid." },
      { name: "error", values: ["text"], default: "", description: "The message an invalid field shows, linked as its description." }
    ],
    states: ["text", "search", "textarea", "select", "hint", "invalid", "disabled"],
    keyboard: ["The native control takes the keyboard as it always does; Tab reaches it and the label names it."]
  };

  connectedCallback() {
    if (!this.control) this.build();
    this.sync();
  }

  attributeChangedCallback(name, previous, next) {
    if (!this.control) return;
    if (name === "type") {
      const value = this.value;
      this.control.remove();
      this.control = null;
      this.build(value);
    } else if (name === "value") this.value = next ?? "";
    this.sync();
  }

  get type() {
    const type = this.getAttribute("type");
    return TYPES.includes(type) ? type : "text";
  }

  get value() {
    return this.control ? this.control.value : this.getAttribute("value") ?? "";
  }

  set value(value) {
    if (this.control) this.control.value = value ?? "";
    else this.setAttribute("value", value ?? "");
  }

  build(value = this.getAttribute("value")) {
    const document = this.ownerDocument;
    const id = this.controlId ??= uniqueId("prism-field");
    if (!this.labelElement) {
      this.labelElement = document.createElement("label");
      this.labelElement.className = "prism-field-label";
      this.hintElement = document.createElement("p");
      this.hintElement.className = "prism-field-hint";
      this.hintElement.id = `${id}-hint`;
      this.errorElement = document.createElement("p");
      this.errorElement.className = "prism-field-error";
      this.errorElement.id = `${id}-error`;
      this.prepend(this.labelElement, this.hintElement, this.errorElement);
    }
    const type = this.type;
    const control = document.createElement(type === "textarea" ? "textarea" : type === "select" ? "select" : "input");
    if (control.tagName === "INPUT") control.type = type;
    control.className = "prism-field-control";
    control.id = id;
    this.labelElement.htmlFor = id;
    this.labelElement.after(control);
    this.control = control;
    if (type === "select") {
      this.fillOptions();
      // Only changes to the prism-option children rebuild the options, never the native options this field writes.
      this.options ??= new MutationObserver((records) => {
        const touched = records.some((record) => {
          if (this.control?.contains(record.target)) return false;
          if (record.target.closest?.("prism-option") ?? record.target.parentElement?.closest("prism-option")) return true;
          return [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeName === "PRISM-OPTION");
        });
        if (touched) this.fillOptions();
      });
      this.options.observe(this, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["value", "selected", "disabled"] });
    } else {
      this.options?.disconnect();
      if (value !== null && value !== undefined) control.value = value;
    }
  }

  // The prism-option children become the native select's options, keeping the chosen value when it still exists.
  fillOptions() {
    const control = this.control;
    if (!control || control.tagName !== "SELECT") return;
    const keep = control.options.length ? control.value : null;
    const document = this.ownerDocument;
    const options = [...this.querySelectorAll("prism-option")].map((source) => {
      const option = document.createElement("option");
      option.value = source.getAttribute("value") ?? source.textContent.trim();
      option.textContent = source.textContent.trim();
      option.disabled = source.hasAttribute("disabled");
      option.selected = source.hasAttribute("selected");
      return option;
    });
    control.replaceChildren(...options);
    const initial = this.getAttribute("value");
    if (keep !== null && options.some((option) => option.value === keep)) control.value = keep;
    else if (!options.some((option) => option.selected) && initial !== null) control.value = initial;
  }

  sync() {
    const control = this.control;
    if (!control) return;
    const label = this.getAttribute("label") ?? "";
    this.labelElement.textContent = label;
    this.labelElement.hidden = !label;
    const hint = this.getAttribute("hint") ?? "";
    this.hintElement.textContent = hint;
    this.hintElement.hidden = !hint;
    const invalid = this.hasAttribute("invalid");
    const error = this.getAttribute("error") ?? "";
    this.errorElement.textContent = error;
    this.errorElement.hidden = !(invalid && error);
    setAttribute(control, "name", this.getAttribute("name"));
    setAttribute(control, "placeholder", control.tagName === "SELECT" ? null : this.getAttribute("placeholder"));
    control.required = this.hasAttribute("required");
    control.disabled = this.hasAttribute("disabled");
    setAttribute(control, "aria-invalid", invalid ? "true" : null);
    const described = [hint ? this.hintElement.id : null, invalid && error ? this.errorElement.id : null].filter(Boolean);
    setAttribute(control, "aria-describedby", described.length ? described.join(" ") : null);
  }
}
