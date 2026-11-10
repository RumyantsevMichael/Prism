// prism-doc-tabs: the strip of open documents, a tablist of prism-doc-tab elements with one selected tab, roving focus, and a strip that scrolls.
// The strip only reports what the person did; the page decides which tabs exist and gives them back with setTabs.
// Tabs may sit in named groups: a prism-doc-tab-group head comes before a group's tabs, which carry the group's name, and a collapsed group shows only
// its head and its selected tab. Dragging a tab or a group head, or Ctrl+Shift+ArrowLeft and ArrowRight on a focused one, moves it, in or out of a group;
// the strip shows the new place at once and reports it with prism-tab-move.
import { Base, deepActiveElement, emit, setAttribute } from "./base.js";
import { groupToneOf, GROUP_TONES } from "./prism-doc-tab-group.js";

// How far a pressed tab moves along the strip before the press becomes a drag.
const DRAG_THRESHOLD = 5;
// How far past a group's last tab a dragged tab still joins that group; further on, it lands after the group.
const GROUP_EDGE = 24;

const isTab = (node) => node?.tagName === "PRISM-DOC-TAB";
const isHead = (node) => node?.tagName === "PRISM-DOC-TAB-GROUP";
const middle = (node) => {
  const box = node.getBoundingClientRect();
  return box.left + box.width / 2;
};

export class PrismDocTabs extends Base {
  static tag = "prism-doc-tabs";
  static observedAttributes = ["label"];
  static catalog = {
    purpose: "The strip of open documents above a page: one tab per open page with one selected, named groups of tabs that collapse, tabs that do not fit scroll inside the strip, and the selected tab stays in view.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The tablist's accessible name." },
      { name: "setTabs(tabs, { groups })", values: ["method"], default: "", description: "Gives the strip its tabs as [{ value, label, text, tip, selected, preview, agent, missing, code, group }] in order, with a group's tabs side by side, and its groups as [{ name, collapsed, tone }], keeping the element and the focus of each tab that stays." },
      { name: "prism-select", values: ["event"], default: "", description: "A click, Enter, or Space on a tab; detail.value names its page." },
      { name: "prism-tab-keep", values: ["event"], default: "", description: "A double click on a tab or its Keep button; detail.value names its page." },
      { name: "prism-tab-close", values: ["event"], default: "", description: "The close button or a middle click on a tab; detail.value names its page." },
      { name: "prism-tab-move", values: ["event"], default: "", description: "A tab or a group dragged to another place, or moved with Ctrl+Shift+arrows; detail.value names the moved tab, or detail.group the moved group, detail.order gives every tab's value in the new order, and detail.groups gives every group as { name, tabs }." },
      { name: "prism-group-toggle", values: ["event"], default: "", description: "A click, Enter, or Space on a group's head; detail.group names the group and detail.collapsed says whether it should now collapse." },
      { name: "prism-group-close", values: ["event"], default: "", description: "The close button of a group's head or a middle click on it; detail.group names the group and detail.tabs lists its tabs." }
    ],
    states: ["default", "many-tabs", "dragging", "groups", "collapsed-group"],
    keyboard: ["Tab enters the strip at the selected tab, then reaches that tab's Keep and close buttons, and leaves at the next control.", "ArrowLeft and ArrowRight move focus between tabs and group heads and wrap at the ends.", "Home and End move to the first and last of them.", "Enter or Space opens the focused tab, or collapses or expands the focused group.", "Ctrl+Shift+ArrowLeft and Ctrl+Shift+ArrowRight, or Cmd+Shift on a Mac, move the focused tab one place, into or out of a group at its ends, or the focused group past its neighbor; Escape during a drag puts the tab or group back."]
  };

  constructor() {
    super();
    this.addEventListener("keydown", (event) => this.onKey(event));
    this.addEventListener("pointerdown", (event) => this.dragStart(event));
    this.addEventListener("click", (event) => {
      // The click that ends a drag only drops the tab; it does not open it.
      if (this.dropped) {
        this.dropped = false;
        event.stopPropagation();
        return;
      }
      const [item, part] = this.hit(event);
      if (!item) return;
      if (part === "keep") emit(this, "prism-tab-keep", { value: item.value });
      else if (part === "close") emit(this, "prism-tab-close", { value: item.value });
      else if (part === "select") this.choose(item);
      else if (part === "toggle") this.toggle(item);
      else if (part === "close-group") this.closeGroup(item);
    });
    this.addEventListener("dblclick", (event) => {
      const [item, part] = this.hit(event);
      if (isTab(item) && part === "select") emit(this, "prism-tab-keep", { value: item.value });
    });
    // A middle click closes a tab or a group, and its press does not start the browser's scrolling mode.
    this.addEventListener("mousedown", (event) => {
      if (event.button === 1 && this.hit(event)[0]) event.preventDefault();
    });
    this.addEventListener("auxclick", (event) => {
      const [item] = this.hit(event);
      if (event.button !== 1 || !item) return;
      event.preventDefault();
      if (isHead(item)) this.closeGroup(item);
      else emit(this, "prism-tab-close", { value: item.value });
    });
    this.addEventListener("focusin", (event) => {
      const [item] = this.hit(event);
      if (item) this.rove(item);
    });
    this.addEventListener("focusout", (event) => {
      if (!this.holds(event.relatedTarget)) this.rove(this.selectedTab());
    });
    this.addEventListener("scroll", () => this.fade(), { passive: true });
  }

  connectedCallback() {
    setAttribute(this, "role", "tablist");
    setAttribute(this, "aria-orientation", "horizontal");
    this.attributeChangedCallback();
    this.resizes ??= globalThis.ResizeObserver ? new ResizeObserver(() => this.reveal()) : null;
    this.resizes?.observe(this);
    this.sync();
  }

  disconnectedCallback() {
    this.resizes?.disconnect();
  }

  attributeChangedCallback() {
    setAttribute(this, "aria-label", this.getAttribute("label") || null);
  }

  get tabs() {
    return [...this.children].filter(isTab);
  }

  get heads() {
    return [...this.children].filter(isHead);
  }

  // The tabs and group heads the arrow keys reach, in order: every head, and every tab a collapsed group does not hide.
  get stops() {
    return [...this.children].filter((node) => (isTab(node) || isHead(node)) && !node.hidden);
  }

  get value() {
    return this.selectedTab()?.value ?? "";
  }

  selectedTab() {
    return this.tabs.find((tab) => tab.hasAttribute("selected")) ?? null;
  }

  // Whether a node is this strip or inside it, also inside a tab's shadow root.
  holds(node) {
    for (let at = node; at; at = at.parentNode ?? at.host) if (at === this) return true;
    return false;
  }

  hit(event) {
    const item = event.composedPath().find((node) => (isTab(node) || isHead(node)) && node.parentElement === this);
    return item ? [item, item.partOf(event)] : [null, null];
  }

  headOf(name) {
    return this.heads.find((head) => head.name === name) ?? null;
  }

  // A group's tabs, in the strip's order.
  membersOf(head) {
    return this.tabs.filter((tab) => tab.getAttribute("group") === head.name);
  }

  // The groups as the strip shows them now: each name with its tabs in order.
  layout() {
    return {
      order: this.tabs.map((tab) => tab.value),
      groups: this.heads.map((head) => ({ name: head.name, tabs: this.membersOf(head).map((tab) => tab.value) }))
    };
  }

  /**
   * Replaces the strip's tabs, in order, with one prism-doc-tab per entry, and puts a group head before the first tab of each group;
   * a tab that stays keeps its element, so a tab with the focus keeps it.
   * `label` names the page for the buttons, `text` is the visible title when it differs, `tip` is the tooltip, `code` marks a repository file,
   * whose path is its subject, and `group` names the entry's group, one of `groups` given as { name, collapsed, tone }.
   */
  setTabs(entries, { groups = [] } = {}) {
    const hadFocus = this.holds(deepActiveElement(this.ownerDocument));
    const existing = new Map(this.tabs.map((tab) => [tab.value, tab]));
    const existingHeads = new Map(this.heads.map((head) => [head.name, head]));
    const known = new Map(groups.map((group) => [group.name, group]));
    const counts = new Map();
    for (const entry of entries) if (entry.group) counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1);
    const next = [];
    const placed = new Set();
    for (const entry of entries) {
      const name = entry.group || null;
      const group = name ? known.get(name) ?? { name } : null;
      if (group && !placed.has(name)) {
        placed.add(name);
        const head = existingHeads.get(name) ?? this.ownerDocument.createElement("prism-doc-tab-group");
        existingHeads.delete(name);
        setAttribute(head, "name", name);
        setAttribute(head, "tone", GROUP_TONES.includes(String(group.tone)) ? String(group.tone) : groupToneOf(name));
        setAttribute(head, "count", String(counts.get(name)));
        head.toggleAttribute("collapsed", Boolean(group.collapsed));
        setAttribute(head, "tip", `${name}, ${counts.get(name)} ${counts.get(name) === 1 ? "tab" : "tabs"}`);
        if (head.textContent !== name) head.textContent = name;
        next.push(head);
      }
      const tab = existing.get(entry.value) ?? this.ownerDocument.createElement("prism-doc-tab");
      existing.delete(entry.value);
      setAttribute(tab, "value", entry.value);
      setAttribute(tab, "label", entry.label);
      setAttribute(tab, "tip", entry.tip || null);
      for (const flag of ["selected", "preview", "agent", "missing"]) tab.toggleAttribute(flag, Boolean(entry[flag]));
      // A repository file's tab names it by its path, since code is its subject.
      tab.toggleAttribute("data-code-subject", Boolean(entry.code));
      setAttribute(tab, "group", name);
      setAttribute(tab, "group-tone", group ? next.findLast(isHead).getAttribute("tone") : null);
      // A collapsed group hides its tabs, except the selected one, so the page that shows always has its tab.
      tab.hidden = Boolean(group?.collapsed) && !entry.selected;
      const text = entry.text ?? entry.label;
      if (tab.textContent !== text) tab.textContent = text;
      next.push(tab);
    }
    for (const stale of [...existing.values(), ...existingHeads.values()]) stale.remove();
    next.forEach((node, index) => {
      if (this.children[index] !== node) this.insertBefore(node, this.children[index] ?? null);
    });
    this.toggleAttribute("empty", next.length === 0);
    this.sync();
    // A tab closed from the keyboard takes the focus with it, so the focus moves to the selected tab.
    if (hadFocus && !this.holds(deepActiveElement(this.ownerDocument))) this.current()?.focus({ preventScroll: true });
    this.reveal();
  }

  current() {
    return this.stops.find((item) => item.hasAttribute("current")) ?? null;
  }

  // Keeps one tab or head in the Tab order: the focused one, or else the selected tab.
  sync() {
    const focused = this.stops.find((item) => item.shadowRoot?.activeElement);
    this.rove(focused ?? this.selectedTab() ?? this.stops[0] ?? null);
  }

  rove(target) {
    for (const item of [...this.tabs, ...this.heads]) item.toggleAttribute("current", item === target);
  }

  choose(tab) {
    emit(this, "prism-select", { value: tab.value });
  }

  toggle(head) {
    emit(this, "prism-group-toggle", { group: head.name, collapsed: !head.collapsed });
  }

  closeGroup(head) {
    emit(this, "prism-group-close", { group: head.name, tabs: this.membersOf(head).map((tab) => tab.value) });
  }

  // Scrolls the strip, and only the strip, so the selected tab shows whole.
  reveal(item = this.selectedTab()) {
    if (item && this.clientWidth > 0) {
      // The strip is the tabs' offset parent, so a tab's offset is its place in the strip's scrolled content.
      const start = item.offsetLeft;
      const end = start + item.offsetWidth;
      if (start < this.scrollLeft) this.scrollLeft = start;
      else if (end > this.scrollLeft + this.clientWidth) this.scrollLeft = end - this.clientWidth;
    }
    this.fade();
  }

  // The strip fades at an end where more tabs wait beyond it.
  fade() {
    this.toggleAttribute("fade-start", this.scrollLeft > 1);
    this.toggleAttribute("fade-end", this.scrollLeft + this.clientWidth < this.scrollWidth - 1);
  }

  // The strip's units: each ungrouped tab, and each group as its head with its tabs, in order.
  units() {
    const units = [];
    for (const node of this.children) {
      if (!(isTab(node) || isHead(node))) continue;
      const group = node.getAttribute(isHead(node) ? "name" : "group");
      if (isHead(node)) units.push([node]);
      else if (group && units.at(-1)?.[0]?.name === group) units.at(-1).push(node);
      else units.push([node]);
    }
    return units;
  }

  // Puts the tab or group under the pointer in its new place: a group moves past whole units, and a tab moves between tabs, joining an expanded
  // group when it lands among the group's tabs, right after its head, or just past its last tab.
  place(item, x) {
    if (isHead(item)) {
      const block = [item, ...this.membersOf(item)];
      const center = (unit) => {
        const shown = unit.filter((node) => !node.hidden);
        return (shown[0].getBoundingClientRect().left + shown.at(-1).getBoundingClientRect().right) / 2;
      };
      const target = this.units().filter((unit) => unit[0] !== item).find((unit) => x < center(unit))?.[0] ?? null;
      if (block.at(-1).nextElementSibling !== target) for (const node of block) this.insertBefore(node, target);
      return;
    }
    const collapsedHead = (node) => {
      const head = isHead(node) ? node : isTab(node) ? this.headOf(node.getAttribute("group")) : null;
      return head?.collapsed ? head : null;
    };
    let before = this.stops.filter((node) => node !== item).find((node) => x < middle(node)) ?? null;
    // A collapsed group takes no tab, so a tab that would land among it lands before its head instead.
    if (isTab(before) && collapsedHead(before)) before = collapsedHead(before);
    if (item.nextElementSibling !== before) this.insertBefore(item, before);
    // Its group now follows from where it sits.
    const previous = item.previousElementSibling;
    const following = item.nextElementSibling;
    let group = null;
    if (isHead(previous) && !previous.collapsed) group = previous.name;
    else if (isTab(previous) && previous.getAttribute("group") && !collapsedHead(previous)) {
      const name = previous.getAttribute("group");
      if (following?.getAttribute("group") === name || x < previous.getBoundingClientRect().right + GROUP_EDGE) group = name;
    }
    this.assign(item, group);
  }

  // Gives a tab the group it now sits in, with that group's tone, and recounts both groups.
  assign(tab, name) {
    const head = name ? this.headOf(name) : null;
    setAttribute(tab, "group", head ? name : null);
    setAttribute(tab, "group-tone", head ? head.getAttribute("tone") : null);
    for (const each of this.heads) setAttribute(each, "count", String(this.membersOf(each).length));
  }

  // A press on a tab's title or a group's head becomes a drag once the pointer moves a few pixels along the strip; until then it is a click.
  dragStart(event) {
    const [item, part] = this.hit(event);
    if (!item || (part !== "select" && part !== "toggle") || event.button !== 0 || this.stops.length < 2) return;
    const startX = event.clientX;
    const before = this.snapshot();
    let dragging = false;
    const cleanup = () => {
      this.removeEventListener("pointermove", move);
      this.removeEventListener("pointerup", drop);
      this.removeEventListener("pointercancel", cancel);
      this.ownerDocument.removeEventListener("keydown", escape, true);
      item.removeAttribute("dragging");
      this.removeAttribute("dragging");
    };
    const move = (next) => {
      if (!dragging) {
        if (Math.abs(next.clientX - startX) < DRAG_THRESHOLD) return;
        dragging = true;
        this.setPointerCapture?.(next.pointerId);
        item.setAttribute("dragging", "");
        this.setAttribute("dragging", "");
      }
      // The strip scrolls when the pointer passes one of its ends, so a tab can be dragged to a place that is out of view.
      const bounds = this.getBoundingClientRect();
      if (next.clientX < bounds.left) this.scrollLeft -= bounds.left - next.clientX;
      else if (next.clientX > bounds.right) this.scrollLeft += next.clientX - bounds.right;
      this.place(item, next.clientX);
    };
    const drop = () => {
      cleanup();
      if (!dragging) return;
      this.dropped = true;
      // A click follows the pointerup only when both land on the same element, so the flag never outlives this drop.
      setTimeout(() => {
        this.dropped = false;
      });
      this.report(item, before);
    };
    const cancel = () => {
      cleanup();
      if (dragging) this.restore(before);
    };
    const escape = (key) => {
      if (key.key !== "Escape" || !dragging) return;
      key.preventDefault();
      key.stopPropagation();
      dragging = false;
      cleanup();
      this.restore(before);
    };
    this.addEventListener("pointermove", move);
    this.addEventListener("pointerup", drop);
    this.addEventListener("pointercancel", cancel);
    this.ownerDocument.addEventListener("keydown", escape, true);
  }

  // The order and groups of the strip's tabs and heads, so a cancelled drag can put them back.
  snapshot() {
    return [...this.children].map((node) => [node, node.getAttribute("group"), node.getAttribute("group-tone")]);
  }

  restore(snapshot) {
    for (const [node, group, tone] of snapshot) {
      if (node.parentElement !== this) continue;
      this.append(node);
      if (isTab(node)) {
        setAttribute(node, "group", group);
        setAttribute(node, "group-tone", tone);
      }
    }
    for (const head of this.heads) setAttribute(head, "count", String(this.membersOf(head).length));
    this.reveal();
  }

  // Reports a moved tab or group with the strip's new order and groups, unless it ended where it started.
  report(item, snapshot) {
    const { order, groups } = this.layout();
    const unchanged = snapshot.every(([node, group], index) => this.children[index] === node && (!isTab(node) || node.getAttribute("group") === group));
    if (unchanged) return;
    this.reveal(item);
    emit(this, "prism-tab-move", isHead(item) ? { value: "", group: item.name, order, groups } : { value: item.value, group: null, order, groups });
  }

  // Ctrl+Shift+arrows, or Cmd+Shift on a Mac, move the focused tab one place, without wrapping, and keep the focus on it.
  // At a group's end the tab first leaves the group, and next to an expanded group it first joins it; a group moves past its neighbor whole.
  moveByKey(item, step) {
    const before = this.snapshot();
    if (isHead(item)) {
      const units = this.units();
      const index = units.findIndex((unit) => unit[0] === item);
      const neighbor = units[index + step];
      if (!neighbor) return;
      const block = units[index];
      const anchor = step < 0 ? neighbor[0] : neighbor.at(-1).nextElementSibling;
      for (const node of block) this.insertBefore(node, anchor);
    } else {
      const group = item.getAttribute("group");
      const head = group ? this.headOf(group) : null;
      const members = head ? this.membersOf(head) : [];
      const neighbor = step < 0 ? item.previousElementSibling : item.nextElementSibling;
      if (head && (step < 0 ? members[0] === item : members.at(-1) === item)) {
        // Leaving a group: to the left the tab steps out before the head, to the right it stays where it is.
        if (step < 0) this.insertBefore(item, head);
        this.assign(item, null);
      } else if (!neighbor) {
        return;
      } else if (!head && isHead(neighbor) && step > 0) {
        if (neighbor.collapsed) this.insertBefore(item, this.membersOf(neighbor).at(-1).nextElementSibling);
        else {
          this.insertBefore(item, neighbor.nextElementSibling);
          this.assign(item, neighbor.name);
        }
      } else if (!head && step < 0 && neighbor.getAttribute("group")) {
        const other = this.headOf(neighbor.getAttribute("group"));
        if (other.collapsed) this.insertBefore(item, other);
        else this.assign(item, other.name);
      } else {
        this.insertBefore(item, step < 0 ? neighbor : neighbor.nextElementSibling);
      }
    }
    item.focus({ preventScroll: true });
    this.report(item, before);
  }

  onKey(event) {
    const [current, part] = this.hit(event);
    if (!current || (part !== "select" && part !== "toggle")) return;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      this.moveByKey(current, event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    const stops = this.stops;
    const index = stops.indexOf(current);
    let next = null;
    if (event.key === "ArrowRight") next = stops[(index + 1) % stops.length];
    else if (event.key === "ArrowLeft") next = stops[(index - 1 + stops.length) % stops.length];
    else if (event.key === "Home") next = stops[0];
    else if (event.key === "End") next = stops.at(-1);
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (isHead(current)) this.toggle(current);
      else this.choose(current);
      return;
    } else return;
    event.preventDefault();
    this.rove(next);
    next.focus({ preventScroll: true });
    this.reveal(next);
  }
}
