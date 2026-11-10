// prism-contents: a document's contents, a list of links to its sections, with the current section marked.
// It renders in light DOM: an <ol> child becomes the list, and children with slot="tools", such as a prism-maximize, go to its header.
// Placed as a child of a box that also holds the document, kit.css lays them out side by side: the contents run the box's full height,
// and their header and list stay in view while the page scrolls the document, the list scrolling on its own only when it is longer than the visible part.
// At 1100px and below the contents sit above the document and the header folds them.
import { Base, distribute, make, setAttribute, toggleAttribute } from "./base.js";

export class PrismContents extends Base {
  static tag = "prism-contents";
  static observedAttributes = ["heading", "open", "pinned"];
  static catalog = {
    purpose: "A document's contents beside it: links to its sections with the current one marked, kept in view while the document scrolls; above the document in a narrow window, folded from its header.",
    options: [
      { name: "heading", values: ["text"], default: "Contents", description: "The header's title, which also names the navigation region." },
      { name: "open", values: ["boolean"], default: "false", description: "Above the document, the list is unfolded." },
      { name: "children", values: ["HTML"], default: "", description: "An <ol> of <li> links, each <li> with depth-1 or depth-2 for a nested section; children with slot=\"tools\" go to the header." },
      { name: "pinned", values: ["boolean"], default: "false", description: "Above the document, the contents header also stays at the top while the document scrolls, as in a maximized view." },
      { name: "--prism-contents-inset", values: ["length"], default: "0", description: "Set on the box that holds the contents: its padding, so the contents rule reaches the box's top and bottom edges." },
      { name: "--prism-contents-top", values: ["length"], default: "0", description: "Where the contents stick, from the scrolling element's content edge; a box that scrolls itself sets it to minus its padding." },
      { name: "markCurrent(link)", values: ["method"], default: "", description: "Marks one link as the current section and scrolls only the list so it is in view." },
      { name: "fit(scroller)", values: ["method"], default: "", description: "Fits the contents into the part of the scrolling element that shows them; call it when that element scrolls or resizes." }
    ],
    states: ["default", "current", "with-tools", "folded", "long-text", "unbroken-name", "many-items"],
    keyboard: ["Tab reaches each link in order.", "Above the document, Enter and Space on the header fold and unfold the list."]
  };

  connectedCallback() {
    if (!this.body) this.build();
    this.sync();
  }

  attributeChangedCallback() {
    if (this.body) this.sync();
  }

  build() {
    setAttribute(this, "role", "navigation");
    this.body = make(this, "div", "prism-contents-body");
    this.head = make(this, "div", "prism-contents-head");
    this.titleElement = make(this, "span", "prism-contents-title");
    this.toggle = make(this, "prism-button", "prism-contents-toggle", { variant: "ghost", size: "sm" });
    this.toggleIcon = make(this, "prism-icon", null, { size: "xs" });
    // The label is a text node, so the button's own content box ends a long title with an ellipsis.
    this.toggleLabel = this.ownerDocument.createTextNode("");
    this.toggle.append(this.toggleIcon, this.toggleLabel);
    this.toggle.addEventListener("click", () => toggleAttribute(this, "open", !this.hasAttribute("open")));
    this.tools = make(this, "div", "prism-contents-tools");
    this.list = make(this, "div", "prism-contents-list");
    this.head.append(this.titleElement, this.toggle, this.tools);
    this.body.append(this.head, this.list);
    this.append(this.body);
    this.children$ = distribute(this, { tools: this.tools, default: this.list }, [this.body]);
  }

  sync() {
    const heading = this.getAttribute("heading") || "Contents";
    const open = this.hasAttribute("open");
    this.titleElement.textContent = heading;
    this.toggleLabel.textContent = heading;
    setAttribute(this, "aria-label", heading);
    setAttribute(this.toggle, "aria-expanded", String(open));
    setAttribute(this.toggleIcon, "name", open ? "chevron-down" : "chevron-right");
  }

  /** The list's links. */
  get links() {
    return [...this.list.querySelectorAll("a")];
  }

  /** Marks one link as the current section, and scrolls the list, and only the list, so it is in view. */
  markCurrent(current) {
    for (const link of this.links) {
      if (link !== current) link.removeAttribute("aria-current");
    }
    if (!current || current.getAttribute("aria-current") === "location") return;
    current.setAttribute("aria-current", "location");
    const list = this.list;
    if (list.scrollHeight <= list.clientHeight) return;
    const frame = list.getBoundingClientRect();
    const entry = current.getBoundingClientRect();
    if (entry.top < frame.top) list.scrollTop -= frame.top - entry.top;
    else if (entry.bottom > frame.bottom) list.scrollTop += entry.bottom - frame.bottom;
  }

  /** Fits the contents into the part of the scrolling element that shows them. */
  fit(scroller) {
    if (!scroller || !this.body) return;
    const area = scroller.getBoundingClientRect();
    const visibleTop = area.top + scroller.clientTop;
    const visibleBottom = visibleTop + scroller.clientHeight;
    const style = getComputedStyle(this.body);
    let height;
    if (style.position === "sticky") {
      // Beside the document the body sticks at the scroller's content edge, moved by its own top offset, and ends with the contents column.
      const column = this.getBoundingClientRect();
      const stuck = visibleTop + Number.parseFloat(getComputedStyle(scroller).paddingTop) + Number.parseFloat(style.top);
      height = Math.min(visibleBottom, column.bottom) - Math.max(column.top, stuck);
    } else {
      height = visibleBottom - this.body.getBoundingClientRect().top;
    }
    this.body.style.setProperty("--prism-contents-fit", `${Math.max(Math.floor(height), 0)}px`);
  }
}
