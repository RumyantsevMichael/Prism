// Generated from src/server/review/public/kit/elements/prism-tree-item.ts by scripts/native-build/compile.mjs.
import { Base, emit, make, setAttribute, toggleAttribute, uniqueId } from "./base.js";
import { remeasure, unwatchShortening, watchShortening } from "../shorten.js";
class PrismTreeItem extends Base {
  static tag = "prism-tree-item";
  static tooltipBoundary = true;
  static observedAttributes = ["label", "expanded", "selected", "href", "meta"];
  static catalog = {
    purpose: "One item of a prism-tree: a row with its label and trailing content, and its child items, which expand and collapse.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The item's text; it ends with an ellipsis when it does not fit, and the tooltip shows it whole." },
      { name: "value", values: ["text"], default: "", description: "The value the tree sends in prism-select when the item is chosen." },
      { name: "expanded", values: ["boolean"], default: "false", description: "Whether its child items show; exposed as aria-expanded when it has child items." },
      { name: "selected", values: ["boolean"], default: "false", description: "Whether it is the current item; exposed as aria-selected." },
      { name: "href", values: ["URL"], default: "", description: "The item's address: the row becomes a link that a middle-click or a Ctrl or Cmd click opens in a new browser tab and the context menu can copy." },
      { name: "tip", values: ["text"], default: "", description: "The tooltip's text on hover and keyboard focus, such as the full label with the item's status." },
      { name: 'slot="start"', values: ["children"], default: "", description: "A glyph before the label, such as an icon, a state, or a phase; a leaf with one gives up the twisty's room." },
      { name: 'slot="end"', values: ["children"], default: "", description: "Content after the label, such as a count or a claim." },
      { name: "meta", values: ["text"], default: "", description: "Short text at the row's end, after the end content, such as a count of changed files or No changes yet; the item names it as its description, not in its name, so the item is found by its label alone." },
      { name: "span.prism-tree-flag", values: ["kit class"], default: "", description: 'A word in slot="end" that flags the row, such as Blocked in the danger tone; with is-muted it names a settled fact, such as Superseded, and with is-warning a difference to look at, such as a file another branch changes.' }
    ],
    states: ["leaf", "collapsed", "expanded", "selected", "glyphs", "link", "flag", "meta"],
    keyboard: ["The tree moves focus between items; Enter or a click selects an item.", "A click on the twisty expands or collapses the item.", "A Ctrl, Cmd, or Shift click or a middle-click on an item with an href opens its address in the browser instead of selecting it."]
  };
  constructor() {
    super();
    this.addEventListener("click", (event) => {
      if (this.itemOf(event) !== this) return;
      const tree = this.tree;
      if (this.hasAttribute("href") && event.shiftKey) return;
      event.preventDefault();
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
    if (name === "expanded" && previous === null !== (next === null)) {
      emit(this, "prism-toggle", { value: this.value, expanded: this.expanded });
      this.tree?.schedule();
    }
  }
  build() {
    const id = uniqueId("prism-tree-item");
    this.row = make(this, "a", "prism-tree-row", { role: "none", tabindex: "-1", draggable: "false" });
    this.twisty = make(this, "span", "prism-tree-twisty", { "aria-hidden": "true" });
    this.twisty.append(make(this, "prism-icon", "", { name: "chevron-right", size: "xs" }));
    this.start = make(this, "span", "prism-tree-start", { id: `${id}-start` });
    this.labelElement = make(this, "span", "prism-tree-label", { id: `${id}-label` });
    this.end = make(this, "span", "prism-tree-end", { id: `${id}-end` });
    this.metaElement = make(this, "span", "prism-tree-meta", { id: `${id}-meta` });
    this.row.append(this.twisty, this.start, this.labelElement, this.end, this.metaElement);
    let pressing = false;
    this.row.addEventListener("pointerdown", () => {
      pressing = true;
    });
    for (const type of ["pointerup", "pointercancel"]) this.row.addEventListener(type, () => setTimeout(() => {
      pressing = false;
    }));
    this.row.addEventListener("focus", () => {
      if (!pressing && this.hasAttribute("tabindex")) this.focus({ focusVisible: true });
    });
    this.group = make(this, "div", "prism-tree-group", { role: "group" });
    this.prepend(this.row);
    this.append(this.group);
    const toEnd = (node) => {
      if (this.end.lastElementChild) this.end.append(this.ownerDocument.createTextNode(" "));
      this.end.append(node);
    };
    const place = () => {
      for (const node of [...this.childNodes]) {
        if (node === this.row || node === this.group) continue;
        if (node.nodeType === 1 && node.tagName === "PRISM-TREE-ITEM") this.group.append(node);
        else if (node.nodeType === 1 && node.getAttribute("slot") === "start") this.start.append(node);
        else if (node.nodeType === 1 && node.getAttribute("slot") === "end") toEnd(node);
        else if (node.nodeType === 3 && !node.textContent.trim()) node.remove();
        else toEnd(node);
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
  /** Whether this leaf keeps the twisty's room: another item at its level, under the same parent, has child items, or its branching tree says top items may. */
  besideParent() {
    if (!this.parentItem && this.tree?.hasAttribute("branching")) return true;
    const siblings = this.parentElement ? [...this.parentElement.children] : [];
    return siblings.some((node) => node !== this && node.tagName === "PRISM-TREE-ITEM" && node.hasChildItems);
  }
  get parentItem() {
    return this.parentElement?.closest("prism-tree-item") ?? null;
  }
  /** The full label, which the tooltip shows when the label is shortened, or the tip that names more. */
  get tooltipText() {
    return this.getAttribute("tip") || (this.getAttribute("label") ?? "");
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
    const href = this.getAttribute("href");
    setAttribute(this.row, "href", href || null);
    const hasStart = this.start.childNodes.length > 0;
    this.start.hidden = !hasStart;
    this.twisty.classList.toggle("is-gone", !parent && hasStart && !this.besideParent());
    const hasEnd = this.end.childNodes.length > 0;
    this.end.hidden = !hasEnd;
    setAttribute(this, "aria-labelledby", [this.labelElement.id, hasEnd ? this.end.id : null, hasStart ? this.start.id : null].filter(Boolean).join(" "));
    const meta = this.getAttribute("meta") ?? "";
    if (this.metaElement.textContent !== meta) this.metaElement.textContent = meta;
    this.metaElement.hidden = !meta;
    const described = (this.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((name) => name && name !== this.metaElement.id);
    if (meta) described.unshift(this.metaElement.id);
    setAttribute(this, "aria-describedby", described.length ? described.join(" ") : null);
  }
}
export {
  PrismTreeItem
};
