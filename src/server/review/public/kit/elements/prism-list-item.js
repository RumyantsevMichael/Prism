// prism-list-item: One option of a prism-listbox, with its kind from slot="meta".
import { Base, setAttribute } from "./base.js";

export class PrismListItem extends Base {
  static tag = "prism-list-item";
  static catalog = {
    purpose: "One option of a prism-listbox, with its kind from slot=\"meta\".",
    options: [{ name: "value", values: ["text"], default: "", description: "The value the listbox sends." }, { name: "selected", values: ["boolean"], default: "false", description: "Whether the option is the chosen one." }],
    states: ["default"],
    keyboard: []
  };

  connectedCallback() {
    setAttribute(this, "role", "option");
    setAttribute(this, "aria-selected", String(this.hasAttribute("selected")));
  }
}
