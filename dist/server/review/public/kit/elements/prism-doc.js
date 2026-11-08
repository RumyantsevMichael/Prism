// prism-doc: holds rendered Markdown in light DOM; kit.css styles its headings, paragraphs, lists, links, tables, quotes, inline code, code blocks, and images.
import { Base } from "./base.js";

export class PrismDoc extends Base {
  static tag = "prism-doc";
  static catalog = {
    purpose: "Holds rendered Markdown in light DOM and styles its headings, paragraphs, lists, links, tables, quotes, inline code, code blocks, and images from the design values.",
    options: [{ name: "children", values: ["HTML"], default: "", description: "The rendered Markdown; tok-<name> spans in its code blocks take the syntax colors." }],
    states: ["default", "rich"],
    keyboard: []
  };
}
