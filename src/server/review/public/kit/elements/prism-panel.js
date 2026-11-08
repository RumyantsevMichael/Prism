// prism-panel: A region with a heading, tools in its header, a body, and a footer, drawn as a card, a plain block, an inset, or an island.
import { Base } from "./base.js";

export class PrismPanel extends Base {
  static tag = "prism-panel";
  static catalog = {
    purpose: "A region with a heading, tools in its header, a body, and a footer, drawn as a card, a plain block, an inset, or an island.",
    options: [{ name: "heading", values: ["text"], default: "", description: "The panel heading." }, { name: "level", values: ["2", "3", "4"], default: "2", description: "The heading level." }, { name: "eyebrow", values: ["text"], default: "", description: "A small line above the heading." }, { name: "variant", values: ["card", "plain", "inset", "island"], default: "card", description: "How the panel is drawn." }, { name: "maximizable", values: ["boolean"], default: "false", description: "Adds a button that maximizes the panel." }],
    states: ["card", "plain", "inset", "island"],
    keyboard: []
  };

  connectedCallback() {
    if (!this.hasAttribute("variant")) this.setAttribute("variant", "card");
  }
}
