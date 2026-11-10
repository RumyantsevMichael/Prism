// prism-panel: a region with an eyebrow, a heading, tools in its header, a body, and a footer, drawn as a card, a plain block, an inset, or an island.
// It renders in light DOM, so the page's content stays in the document: children with slot="tools" go to the header, slot="footer" after the body,
// and every other child, also one added later, into the body.
import { Base, distribute, emit, make, setAttribute, toggleAttribute } from "./base.js";

const VARIANTS = ["card", "plain", "inset", "island"];

export class PrismPanel extends Base {
  static tag = "prism-panel";
  static observedAttributes = ["heading", "level", "eyebrow", "maximizable", "maximized"];
  static catalog = {
    purpose: "A region with a heading, tools in its header, a body, and a footer, drawn as a card, a plain block, an inset, or an island on the canvas.",
    options: [
      { name: "heading", values: ["text"], default: "", description: "The panel's heading." },
      { name: "level", values: ["2", "3", "4", "5", "6"], default: "2", description: "The heading's level." },
      { name: "eyebrow", values: ["text"], default: "", description: "A small line above the heading, such as the kind of record." },
      { name: "variant", values: VARIANTS, default: "card", description: "card is a bordered surface, plain has no frame, inset is sunken, and island floats on the canvas with --prism-radius-island, --prism-shadow-island, and --prism-color-island-edge." },
      { name: "flush", values: ["boolean"], default: "false", description: "The body has no padding, for content that draws its own edges, such as a page bar." },
      { name: "maximizable", values: ["boolean"], default: "false", description: "Adds a prism-maximize button, named Maximize or Restore, that toggles maximized and sends prism-maximize with detail.maximized." },
      { name: "maximized", values: ["boolean"], default: "false", description: "The panel fills the window." }
    ],
    states: ["card", "plain", "inset", "island", "tools-and-footer", "maximizable"],
    keyboard: ["The Maximize button takes Enter and Space.", "Escape restores a maximized panel while focus is inside it."]
  };

  constructor() {
    super();
    this.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.hasAttribute("maximized") && this.hasAttribute("maximizable")) {
        event.preventDefault();
        this.toggleMaximized(false);
        this.maximizeButton?.focus();
      }
    });
  }

  connectedCallback() {
    if (!VARIANTS.includes(this.getAttribute("variant"))) this.setAttribute("variant", "card");
    if (!this.body) this.build();
    this.sync();
  }

  attributeChangedCallback() {
    if (this.body) this.sync();
  }

  build() {
    this.header = make(this, "header", "prism-panel-head");
    this.titles = make(this, "div", "prism-panel-titles");
    this.eyebrowElement = make(this, "p", "prism-panel-eyebrow");
    this.tools = make(this, "div", "prism-panel-tools");
    this.body = make(this, "div", "prism-panel-body");
    this.footer = make(this, "footer", "prism-panel-foot");
    this.titles.append(this.eyebrowElement);
    this.header.append(this.titles, this.tools);
    this.prepend(this.header);
    this.append(this.body, this.footer);
    this.children$ = distribute(this, { tools: this.tools, footer: this.footer, default: this.body }, [this.header, this.body, this.footer]);
  }

  get level() {
    const level = Number(this.getAttribute("level"));
    return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2;
  }

  sync() {
    const heading = this.getAttribute("heading") ?? "";
    const level = this.level;
    if (!this.headingElement || this.headingElement.tagName !== `H${level}`) {
      const next = make(this, `h${level}`, "prism-panel-heading");
      if (this.headingElement) this.headingElement.replaceWith(next);
      else this.titles.append(next);
      this.headingElement = next;
    }
    this.headingElement.textContent = heading;
    this.headingElement.hidden = !heading;
    const eyebrow = this.getAttribute("eyebrow") ?? "";
    this.eyebrowElement.textContent = eyebrow;
    this.eyebrowElement.hidden = !eyebrow;

    const maximizable = this.hasAttribute("maximizable");
    if (maximizable && !this.maximizeButton) {
      this.maximizeButton = make(this, "prism-maximize", "prism-panel-maximize");
      this.maximizeButton.addEventListener("prism-maximize-request", (event) => {
        event.stopPropagation();
        this.toggleMaximized(event.detail.maximized);
      });
      this.header.append(this.maximizeButton);
    } else if (!maximizable && this.maximizeButton) {
      this.maximizeButton.remove();
      this.maximizeButton = null;
    }
    if (this.maximizeButton) toggleAttribute(this.maximizeButton, "maximized", this.hasAttribute("maximized"));
    const hasTools = this.tools.childElementCount > 0;
    this.tools.hidden = !hasTools;
    this.header.hidden = !heading && !eyebrow && !hasTools && !maximizable;
    this.footer.hidden = this.footer.childNodes.length === 0;
    if (!this.watching) {
      // Tools and a footer that arrive later show their region.
      this.watching = new MutationObserver(() => this.sync());
      this.watching.observe(this.tools, { childList: true });
      this.watching.observe(this.footer, { childList: true });
    }
  }

  /** Sets the maximized state and sends prism-maximize. */
  toggleMaximized(on) {
    if (on === this.hasAttribute("maximized")) return;
    toggleAttribute(this, "maximized", on);
    emit(this, "prism-maximize", { maximized: on });
  }
}
