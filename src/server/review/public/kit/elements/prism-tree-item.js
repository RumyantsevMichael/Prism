// prism-tree-item: one item of a prism-tree in light DOM: a row with a twisty, its label, and children with slot="end", then its child items in a group.
import { Base, emit, make, setAttribute, toggleAttribute, uniqueId } from "./base.js";
import { remeasure, unwatchShortening, watchShortening } from "../shorten.js";

export class PrismTreeItem extends Base {
  static tag = "prism-tree-item";
  static tooltipBoundary = true;
  static observedAttributes = ["label", "expanded", "selected"];
  static catalog = {
    purpose: "One item of a prism-tree: a row with its label and trailing content, and its child items, which expand and collapse.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The item's text; it ends with an ellipsis when it does not fit, and the tooltip shows it whole." },
      { name: "value", values: ["text"], default: "", description: "The value the tree sends in prism-select when the item is chosen." },
      { name: "expanded", values: ["boolean"], default: "false", description: "Whether its child items show; exposed as aria-expanded when it has child items." },
      { name: "selected", values: ["boolean"], default: "false", description: "Whether it is the current item; exposed as aria-selected." },
      { name: "slot=\"end\"", values: ["children"], default: "", description: "Content after the label, such as a count or a claim." }
    ],
    states: ["leaf", "collapsed", "expanded", "selected"],
    keyboard: ["The tree moves focus between items; Enter or a click selects an item.", "A click on the twisty expands or collapses the item."]
  };

  constructor() {
    super();
    this.addEventListener("click", (event) => {
      if (this.itemOf(event) !== this) return;
      const tree = this.tree;
      if (event.composedPath().includes(this.twisty)) {
        if (this.hasChildItems) this.expanded = !this.expanded;
        tree?.rove(this);
        return;
      }
      tree?.choose(this);
    });
  }

  connectedCallback() {
    if (!this.row) this.build();
    this.sync();
    watchShortening(this, this.labelElement, { focusable: () => true });
    this.tree?.schedule();
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  attributeChangedCallback(name, previous, next) {
    if (!this.row) return;
    this.sync();
    if (name === "expanded" && (previous === null) !== (next === null)) {
      emit(this, "prism-toggle", { value: this.value, expanded: this.expanded });
      this.tree?.schedule();
    }
  }

  build() {
    const id = uniqueId("prism-tree-item");
    this.row = make(this, "div", "prism-tree-row");
    this.twisty = make(this, "span", "prism-tree-twisty", { "aria-hidden": "true" });
    this.twisty.append(make(this, "prism-icon", "", { name: "chevron-right", size: "xs" }));
    this.labelElement = make(this, "span", "prism-tree-label", { id: `${id}-label` });
    this.end = make(this, "span", "prism-tree-end", { id: `${id}-end` });
    this.row.append(this.twisty, this.labelElement, this.end);
    this.group = make(this, "div", "prism-tree-group", { role: "group" });
    this.prepend(this.row);
    this.append(this.group);
    // Child items go to the group, slot="end" children to the end of the row; text and anything else stays out of the row.
    const place = () => {
      for (const node of [...this.childNodes]) {
        if (node === this.row || node === this.group) continue;
        if (node.nodeType === 1 && node.tagName === "PRISM-TREE-ITEM") this.group.append(node);
        else if (node.nodeType === 1 && node.getAttribute("slot") === "end") this.end.append(node);
        else if (node.nodeType === 3 && !node.textContent.trim()) node.remove();
        else this.end.append(node);
      }
      this.sync();
      this.tree?.schedule();
    };
    place();
    this.children$ = new MutationObserver(place);
    this.children$.observe(this, { childList: true });
    this.groupWatch = new MutationObserver(() => {
      this.sync();
      this.tree?.schedule();
    });
    this.groupWatch.observe(this.group, { childList: true });
  }

  get tree() {
    return this.closest("prism-tree");
  }

  get value() {
    return this.getAttribute("value") ?? this.getAttribute("label") ?? "";
  }

  get expanded() {
    return this.hasAttribute("expanded");
  }

  set expanded(on) {
    toggleAttribute(this, "expanded", Boolean(on));
  }

  get selected() {
    return this.hasAttribute("selected");
  }

  set selected(on) {
    toggleAttribute(this, "selected", Boolean(on));
  }

  get childItems() {
    return this.group ? [...this.group.children].filter((node) => node.tagName === "PRISM-TREE-ITEM") : [];
  }

  get hasChildItems() {
    return this.childItems.length > 0;
  }

  get parentItem() {
    return this.parentElement?.closest("prism-tree-item") ?? null;
  }

  /** The full label, which the tooltip shows when the label is shortened. */
  get tooltipText() {
    return this.getAttribute("label") ?? "";
  }

  itemOf(event) {
    return event.composedPath().find((node) => node.tagName === "PRISM-TREE-ITEM") ?? null;
  }

  sync() {
    let level = 1;
    for (let node = this.parentItem; node; node = node.parentItem) level += 1;
    setAttribute(this, "role", "treeitem");
    setAttribute(this, "aria-level", String(level));
    this.style.setProperty("--prism-tree-level", String(level - 1));
    const label = this.getAttribute("label") ?? "";
    if (this.labelElement.textContent !== label) {
      this.labelElement.textContent = label;
      remeasure(this);
    }
    const parent = this.hasChildItems;
    setAttribute(this, "aria-expanded", parent ? String(this.expanded) : null);
    this.twisty.classList.toggle("is-leaf", !parent);
    setAttribute(this.twisty.firstElementChild, "name", this.expanded ? "chevron-down" : "chevron-right");
    this.group.hidden = !parent || !this.expanded;
    setAttribute(this, "aria-selected", String(this.selected));
    const hasEnd = this.end.childNodes.length > 0;
    this.end.hidden = !hasEnd;
    setAttribute(this, "aria-labelledby", hasEnd ? `${this.labelElement.id} ${this.end.id}` : this.labelElement.id);
  }
}
