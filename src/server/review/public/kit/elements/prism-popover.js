// prism-popover: A non-modal panel on frosted glass that a kit button opens.
import { Base } from "./base.js";

export class PrismPopover extends Base {
  static tag = "prism-popover";
  static catalog = {
    purpose: "A non-modal panel on frosted glass that a kit button opens.",
    options: [{ name: "for", values: ["id"], default: "", description: "The kit button that opens it." }, { name: "heading", values: ["text"], default: "", description: "The popover heading and accessible name." }, { name: "open", values: ["boolean"], default: "false", description: "Whether the popover shows." }],
    states: ["closed"],
    keyboard: []
  };

}
