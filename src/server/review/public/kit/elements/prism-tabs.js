// prism-tabs: a named tablist of prism-tab elements with one selected tab, roving focus, and a strip that scrolls.
import { Base, emit, setAttribute } from "./base.js";

export class PrismTabs extends Base {
  static tag = "prism-tabs";
  static observedAttributes = ["label"];
  static catalog = {
    purpose: "A strip of sub-tabs with exactly one selected tab; tabs that do not fit scroll inside the strip.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The tablist's accessible name." },
      { name: "value", values: ["property"], default: "", description: "The selected tab's value; setting it selects that tab." }
    ],
    states: ["default", "second-selected", "disabled-tab"],
    keyboard: ["Tab enters the strip at the selected tab and leaves it at the next control.", "ArrowLeft and ArrowRight move focus between tabs and wrap at the ends.", "Home and End move to the first and last tab.", "Enter, Space, or a click selects the focused tab and sends prism-select."]
  };

  constructor() {
    super();
    this.addEventListener("keydown", (event) => this.onKey(event));
    this.addEventListener("click", (event) => {
      const tab = this.tabFrom(event);
      if (tab) this.choose(tab);
    });
    this.addEventListener("focusout", (event) => {
      if (!this.contains(event.relatedTarget)) this.rove(this.selectedTab());
    });
  }

  connectedCallback() {
    setAttribute(this, "role", "tablist");
    this.attributeChangedCallback();
    this.sync();
    this.observer ??= new MutationObserver(() => this.sync());
    this.observer.observe(this, { childList: true, subtree: true, attributeFilter: ["selected", "disabled"] });
  }

  disconnectedCallback() {
    this.observer?.disconnect();
  }

  attributeChangedCallback() {
    setAttribute(this, "aria-label", this.getAttribute("label") || null);
  }

  get tabs() {
    return [...this.querySelectorAll("prism-tab")].filter((tab) => tab.closest("prism-tabs") === this);
  }

  get value() {
    return this.selectedTab()?.getAttribute("value") ?? "";
  }

  set value(value) {
    const tab = this.tabs.find((item) => item.getAttribute("value") === String(value));
    if (tab) this.select(tab);
  }

  selectedTab() {
    return this.tabs.find((tab) => tab.hasAttribute("selected")) ?? null;
  }

  // Keeps exactly one tab selected and only one tab in the Tab order.
  sync() {
    if (this.syncing) return;
    this.syncing = true;
    const tabs = this.tabs;
    const selected = tabs.filter((tab) => tab.hasAttribute("selected"));
    let keep = selected[0] ?? tabs.find((tab) => !tab.hasAttribute("disabled")) ?? null;
    for (const tab of tabs) {
      if (tab !== keep && tab.hasAttribute("selected")) tab.removeAttribute("selected");
      setAttribute(tab, "aria-selected", String(tab === keep));
    }
    if (keep && !keep.hasAttribute("selected")) keep.setAttribute("selected", "");
    const focused = tabs.find((tab) => tab === this.ownerDocument.activeElement);
    this.rove(focused ?? keep);
    queueMicrotask(() => { this.syncing = false; });
  }

  rove(target) {
    for (const tab of this.tabs) setAttribute(tab, "tabindex", tab === target ? "0" : "-1");
  }

  tabFrom(event) {
    const tab = event.composedPath().find((node) => node.tagName === "PRISM-TAB");
    return tab && tab.closest("prism-tabs") === this && !tab.hasAttribute("disabled") ? tab : null;
  }

  select(tab) {
    for (const item of this.tabs) item.toggleAttribute("selected", item === tab);
    this.rove(tab);
  }

  choose(tab) {
    this.select(tab);
    emit(this, "prism-select", { value: tab.getAttribute("value") ?? "" });
  }

  onKey(event) {
    const current = this.tabFrom(event);
    if (!current) return;
    const tabs = this.tabs.filter((tab) => !tab.hasAttribute("disabled"));
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
    next.focus();
    next.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}
