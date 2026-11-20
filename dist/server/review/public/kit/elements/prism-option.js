// Generated from src/server/review/public/kit/elements/prism-option.ts by scripts/native-build/compile.mjs.
import { Base } from "./base.js";
class PrismOption extends Base {
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
export {
  PrismOption
};
