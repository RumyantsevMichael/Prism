// prism-code: holds a code block (<pre><code>) in light DOM, with line numbers from `start` in a gutter when `numbers` is set,
// and tok-<name> spans colored by --prism-color-syntax-<name>, or by the ink color for a name the theme does not define.
import { Base, make, setAttribute } from "./base.js";

export class PrismCode extends Base {
  static tag = "prism-code";
  static observedAttributes = ["numbers", "start", "language"];
  static catalog = {
    purpose: "Holds a code block with optional line numbers and syntax colors from tok-<name> spans.",
    options: [
      { name: "language", values: ["text"], default: "", description: "The code's language, exposed as data-language on the block." },
      { name: "numbers", values: ["boolean"], default: "false", description: "Shows line numbers in a gutter." },
      { name: "start", values: ["number"], default: "1", description: "The first line number." }
    ],
    states: ["default", "numbers", "syntax"],
    keyboard: ["A block wider than its container scrolls sideways inside itself."]
  };

  connectedCallback() {
    if (!this.observer) {
      this.observer = new MutationObserver(() => this.render());
    }
    this.render();
  }

  disconnectedCallback() {
    this.observer?.disconnect();
  }

  attributeChangedCallback() {
    if (this.observer) this.render();
  }

  render() {
    this.observer.disconnect();
    const pre = this.querySelector(":scope > pre");
    setAttribute(pre, "data-language", this.getAttribute("language") || null);
    const numbers = this.hasAttribute("numbers") && pre;
    if (numbers) {
      this.gutter ??= make(this, "span", "prism-code-gutter", { "aria-hidden": "true" });
      const start = Number.parseInt(this.getAttribute("start") ?? "1", 10);
      const first = Number.isFinite(start) ? start : 1;
      const lines = pre.textContent.replace(/\n$/, "").split("\n").length;
      this.gutter.textContent = Array.from({ length: lines }, (_, index) => String(first + index)).join("\n");
      if (this.gutter.nextSibling !== pre) this.insertBefore(this.gutter, pre);
    } else this.gutter?.remove();
    this.toggleAttribute("data-numbered", Boolean(numbers));
    this.observer.observe(this, { childList: true, subtree: true, characterData: true });
  }
}
