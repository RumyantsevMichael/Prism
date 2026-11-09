// prism-doc-tabs: the strip of open documents, a tablist of prism-doc-tab elements with one selected tab, roving focus, and a strip that scrolls.
// The strip only reports what the person did; the page decides which tabs exist and gives them back with setTabs.
import { Base, deepActiveElement, emit, setAttribute } from "./base.js";

export class PrismDocTabs extends Base {
  static tag = "prism-doc-tabs";
  static observedAttributes = ["label"];
  static catalog = {
    purpose: "The strip of open documents above a page: one tab per open page with one selected, tabs that do not fit scroll inside the strip, and the selected tab stays in view.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The tablist's accessible name." },
      { name: "setTabs(tabs)", values: ["method"], default: "", description: "Gives the strip its tabs as [{ value, label, text, tip, selected, preview, agent, missing, code }] in order, keeping the element and the focus of each tab that stays." },
      { name: "prism-select", values: ["event"], default: "", description: "A click, Enter, or Space on a tab; detail.value names its page." },
      { name: "prism-tab-keep", values: ["event"], default: "", description: "A double click on a tab or its Keep button; detail.value names its page." },
      { name: "prism-tab-close", values: ["event"], default: "", description: "The close button or a middle click on a tab; detail.value names its page." }
    ],
    states: ["default", "many-tabs"],
    keyboard: ["Tab enters the strip at the selected tab, then reaches that tab's Keep and close buttons, and leaves at the next control.", "ArrowLeft and ArrowRight move focus between tabs and wrap at the ends.", "Home and End move to the first and last tab.", "Enter or Space opens the focused tab."]
  };

  constructor() {
    super();
    this.addEventListener("keydown", (event) => this.onKey(event));
    this.addEventListener("click", (event) => {
      const [tab, part] = this.hit(event);
      if (!tab) return;
      if (part === "keep") emit(this, "prism-tab-keep", { value: tab.value });
      else if (part === "close") emit(this, "prism-tab-close", { value: tab.value });
      else if (part === "select") this.choose(tab);
    });
    this.addEventListener("dblclick", (event) => {
      const [tab, part] = this.hit(event);
      if (tab && part === "select") emit(this, "prism-tab-keep", { value: tab.value });
    });
    // A middle click closes a tab, and its press does not start the browser's scrolling mode.
    this.addEventListener("mousedown", (event) => {
      if (event.button === 1 && this.hit(event)[0]) event.preventDefault();
    });
    this.addEventListener("auxclick", (event) => {
      const [tab] = this.hit(event);
      if (event.button !== 1 || !tab) return;
      event.preventDefault();
      emit(this, "prism-tab-close", { value: tab.value });
    });
    this.addEventListener("focusin", (event) => {
      const [tab] = this.hit(event);
      if (tab) this.rove(tab);
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
    return [...this.children].filter((node) => node.tagName === "PRISM-DOC-TAB");
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
    const tab = event.composedPath().find((node) => node.tagName === "PRISM-DOC-TAB" && node.parentElement === this);
    return tab ? [tab, tab.partOf(event)] : [null, null];
  }

  /**
   * Replaces the strip's tabs, in order, with one prism-doc-tab per entry; a tab that stays keeps its element, so a tab with the focus keeps it.
   * `label` names the page for the buttons, `text` is the visible title when it differs, `tip` is the tooltip, and `code` marks a repository file, whose path is its subject.
   */
  setTabs(entries) {
    const hadFocus = this.holds(deepActiveElement(this.ownerDocument));
    const existing = new Map(this.tabs.map((tab) => [tab.value, tab]));
    const next = entries.map((entry) => {
      const tab = existing.get(entry.value) ?? this.ownerDocument.createElement("prism-doc-tab");
      existing.delete(entry.value);
      setAttribute(tab, "value", entry.value);
      setAttribute(tab, "label", entry.label);
      setAttribute(tab, "tip", entry.tip || null);
      for (const name of ["selected", "preview", "agent", "missing"]) tab.toggleAttribute(name, Boolean(entry[name]));
      // A repository file's tab names it by its path, since code is its subject.
      tab.toggleAttribute("data-code-subject", Boolean(entry.code));
      const text = entry.text ?? entry.label;
      if (tab.textContent !== text) tab.textContent = text;
      return tab;
    });
    for (const stale of existing.values()) stale.remove();
    next.forEach((tab, index) => {
      if (this.children[index] !== tab) this.insertBefore(tab, this.children[index] ?? null);
    });
    this.toggleAttribute("empty", next.length === 0);
    this.sync();
    // A tab closed from the keyboard takes the focus with it, so the focus moves to the selected tab.
    if (hadFocus && !this.holds(deepActiveElement(this.ownerDocument))) this.current()?.focus({ preventScroll: true });
    this.reveal();
  }

  current() {
    return this.tabs.find((tab) => tab.hasAttribute("current")) ?? null;
  }

  // Keeps one tab in the Tab order: the focused tab, or else the selected one.
  sync() {
    const focused = this.tabs.find((tab) => tab.shadowRoot?.activeElement);
    this.rove(focused ?? this.selectedTab() ?? this.tabs[0] ?? null);
  }

  rove(target) {
    for (const tab of this.tabs) tab.toggleAttribute("current", tab === target);
  }

  choose(tab) {
    emit(this, "prism-select", { value: tab.value });
  }

  // Scrolls the strip, and only the strip, so the selected tab shows whole.
  reveal(tab = this.selectedTab()) {
    if (tab && this.clientWidth > 0) {
      // The strip is the tabs' offset parent, so a tab's offset is its place in the strip's scrolled content.
      const start = tab.offsetLeft;
      const end = start + tab.offsetWidth;
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

  onKey(event) {
    const [current, part] = this.hit(event);
    if (!current || part !== "select") return;
    const tabs = this.tabs;
    const index = tabs.indexOf(current);
    let next = null;
    if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
    else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs.at(-1);
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.choose(current);
      return;
    } else return;
    event.preventDefault();
    this.rove(next);
    next.focus({ preventScroll: true });
    this.reveal(next);
  }
}
