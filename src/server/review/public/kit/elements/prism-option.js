// prism-option: one option of a select prism-field, given by its value, its text, and whether it is selected.
import { Base } from "./base.js";

export class PrismOption extends Base {
  static tag = "prism-option";
  static catalog = {
    purpose: "One option of a select prism-field; the field turns its options into the native select's options.",
    options: [
      { name: "value", values: ["text"], default: "", description: "The value the field takes when this option is chosen." },
      { name: "selected", values: ["boolean"], default: "false", description: "The option the field starts with." },
      { name: "disabled", values: ["boolean"], default: "false", description: "The option cannot be chosen." }
    ],
    states: ["default", "selected"],
    keyboard: ["The native select moves between options with the arrow keys."]
  };
}
