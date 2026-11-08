// prism-listbox: A list of options to choose one from, driven by its own focus or by a kit field.
import { Base, setAttribute } from "./base.js";

export class PrismListbox extends Base {
  static tag = "prism-listbox";
  static catalog = {
    purpose: "A list of options to choose one from, driven by its own focus or by a kit field.",
    options: [{ name: "label", values: ["text"], default: "", description: "The listbox accessible name." }, { name: "for", values: ["id"], default: "", description: "A kit field that drives the listbox." }],
    states: ["default"],
    keyboard: []
  };

  connectedCallback() {
    setAttribute(this, "role", "listbox");
    setAttribute(this, "aria-label", this.getAttribute("label") || null);
  }
}
