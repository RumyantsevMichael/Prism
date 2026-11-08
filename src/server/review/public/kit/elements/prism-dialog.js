// prism-dialog: A modal dialog on frosted glass over a blurred scrim.
import { Base } from "./base.js";

export class PrismDialog extends Base {
  static tag = "prism-dialog";
  static catalog = {
    purpose: "A modal dialog on frosted glass over a blurred scrim.",
    options: [{ name: "heading", values: ["text"], default: "", description: "The dialog heading and accessible name." }, { name: "open", values: ["boolean"], default: "false", description: "Whether the dialog shows." }, { name: "size", values: ["sm", "md", "lg"], default: "md", description: "The dialog width." }, { name: "placement", values: ["center", "start", "bottom"], default: "center", description: "Where the dialog opens." }],
    states: ["closed"],
    keyboard: []
  };

}
