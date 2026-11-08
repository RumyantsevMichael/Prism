// prism-code: Holds a code block with optional line numbers and syntax colors.
import { Base } from "./base.js";

export class PrismCode extends Base {
  static tag = "prism-code";
  static catalog = {
    purpose: "Holds a code block with optional line numbers and syntax colors.",
    options: [{ name: "language", values: ["text"], default: "", description: "The code language." }, { name: "numbers", values: ["boolean"], default: "false", description: "Shows line numbers." }, { name: "start", values: ["number"], default: "1", description: "The first line number." }],
    states: ["default"],
    keyboard: []
  };

}
