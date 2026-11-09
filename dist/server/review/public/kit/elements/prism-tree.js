// prism-tree: a tree of prism-tree-item elements with one Tab stop, arrow-key movement, expansion, and single selection, such as the sidebar navigation.
import { Base, emit, setAttribute } from "./base.js";

export class PrismTree extends Base {
  static tag = "prism-tree";
  static observedAttributes = ["label"];
  static catalog = {
    purpose: "A tree of items that expand and collapse and one of which is selected, such as the sidebar's places, initiatives, and library.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The tree's accessible name." },
      { name: "rail", values: ["boolean"], default: "false", description: "Shows each top item's start glyph alone, with a count badge on it and the label as its tooltip, as a collapsed sidebar does." }
    ],
    states: ["default", "nested", "selected", "rail"],
    keyboard: [
      "Only one item is in the Tab order.",
      "ArrowDown and ArrowUp move to the next and previous visible item; Home and End move to the first and last.",
      "ArrowRight expands a collapsed item or moves to its first child; ArrowLeft collapses an expanded item or moves to its parent.",
      "Enter or a click selects an item and sends prism-select with detail.value."
    ]
  };

  constructor() {
    super();
    this.addEventListener("keydown", (event) => this.onKey(event));
    this.addEventListener("focusin", (event) => {
      const item = this.itemOf(event);
      if (item) this.rove(item);
    });
  }

  connectedCallback() {
    setAttribute(this, "role", "tree");
    this.attributeChangedCallback();
    this.schedule();
  }

  attributeChangedCallback() {
    setAttribute(this, "aria-label", this.getAttribute("label") || null);
  }

  /** Every item of the tree in document order. */
  get items() {
    return [...this.querySelectorAll("prism-tree-item")].filter((item) => item.closest("prism-tree") === this);
  }

  /** The items whose ancestors are all expanded. */
  get visibleItems() {
    return this.items.filter((item) => {
      for (let parent = item.parentItem; parent; parent = parent.parentItem) if (!parent.expanded) return false;
      return true;
    });
  }

  /** Recomputes the Tab stop once, after a burst of changes. */
  schedule() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      const visible = this.visibleItems;
      const current = visible.includes(this.current) ? this.current : visible.find((item) => item.selected) ?? visible[0];
      this.rove(current);
    });
  }

  rove(target) {
    this.current = target ?? null;
    for (const item of this.items) item.setAttribute("tabindex", item === target ? "0" : "-1");
  }

  move(target) {
    if (!target) return;
    this.rove(target);
    target.focus();
  }

  /** Selects one item, clears the others, and sends prism-select. */
  choose(item) {
    for (const other of this.items) other.selected = other === item;
    this.move(item);
    emit(this, "prism-select", { value: item.value });
  }

  itemOf(event) {
    const item = event.composedPath().find((node) => node.tagName === "PRISM-TREE-ITEM");
    return item && item.closest("prism-tree") === this ? item : null;
  }

  onKey(event) {
    const item = this.itemOf(event);
    if (!item || event.altKey || event.ctrlKey || event.metaKey) return;
    // Keys pressed in a control inside an item, such as a button in its end content, belong to that control.
    const origin = event.composedPath()[0];
    if (origin !== item) return;
    const visible = this.visibleItems;
    const index = visible.indexOf(item);
    switch (event.key) {
      case "ArrowDown":
        this.move(visible[index + 1]);
        break;
      case "ArrowUp":
        this.move(visible[index - 1]);
        break;
      case "Home":
        this.move(visible[0]);
        break;
      case "End":
        this.move(visible.at(-1));
        break;
      case "ArrowRight":
        if (!item.hasChildItems) break;
        if (!item.expanded) item.expanded = true;
        else this.move(item.childItems[0]);
        break;
      case "ArrowLeft":
        if (item.hasChildItems && item.expanded) item.expanded = false;
        else this.move(item.parentItem);
        break;
      case "Enter":
        this.choose(item);
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
