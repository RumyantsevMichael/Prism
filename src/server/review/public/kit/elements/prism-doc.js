// prism-doc: holds rendered Markdown in light DOM; kit.css styles its headings, paragraphs, lists, links, tables, quotes, inline code, code blocks, images, and the blocks and words a diff marks.
import { Base } from "./base.js";

export class PrismDoc extends Base {
  static tag = "prism-doc";
  static catalog = {
    purpose: "Holds rendered Markdown in light DOM and styles its headings, paragraphs, lists, links, tables, quotes, inline code, code blocks, and images from the design values.",
    options: [
      { name: "children", values: ["HTML"], default: "", description: "The rendered Markdown; tok-<name> spans in its code blocks take the syntax colors." },
      { name: "data-diff on a block", values: ["added", "removed", "changed"], default: "", description: "Marks a top-level block as a change against an earlier version, with a bar and fill in the diff colors; inside a changed block, ins.prism-doc-ins and del.prism-doc-del mark the words it gained and lost." }
    ],
    states: ["default", "rich", "diff"],
    keyboard: []
  };
}
