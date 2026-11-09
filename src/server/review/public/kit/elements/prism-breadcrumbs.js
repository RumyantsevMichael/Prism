// prism-breadcrumbs: the trail of the current page's place as a navigation landmark named Breadcrumb. Its child links become an ordered list,
// the last marked as the current page; a crumb that does not fit ends with an ellipsis and is marked shortened, and the last crumb shortens last.
// A trail that does not fit even with every crumb shortened scrolls inside itself and keeps its end, the current page, in view.
import { Base, make, setAttribute } from "./base.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

export class PrismBreadcrumbs extends Base {
  static tag = "prism-breadcrumbs";
  static catalog = {
    purpose: "The trail of the current page's place, initiative, and slice as a breadcrumb navigation, whose crumbs shorten when they do not fit.",
    options: [{ name: "<a> children", values: ["links"], default: "", description: "The crumbs in order; the last is the current page. Replacing the children replaces the trail." }],
    states: ["default", "one-crumb"],
    keyboard: ["Each crumb is a link that Tab reaches; a shortened crumb shows its full text in the tooltip on keyboard focus."]
  };

  connectedCallback() {
    setAttribute(this, "role", "navigation");
    setAttribute(this, "aria-label", "Breadcrumb");
    if (!this.list) {
      this.list = make(this, "ol", "prism-breadcrumbs-list");
      this.observer = new MutationObserver(() => this.render());
      this.resizes = globalThis.ResizeObserver ? new ResizeObserver(() => this.showEnd()) : null;
      this.resizes?.observe(this.list);
    }
    this.render();
    this.observer.observe(this, { childList: true });
  }

  disconnectedCallback() {
    this.observer?.disconnect();
    for (const link of this.links ?? []) unwatchShortening(link);
  }

  render() {
    const added = [...this.children].filter((node) => node.tagName === "A");
    if (!added.length && this.list.parentNode === this) {
      for (const link of this.links ?? []) watchShortening(link, link, { focusable: () => true });
      return;
    }
    const kept = this.list.parentNode === this ? [...this.list.querySelectorAll(":scope > li > a")] : [];
    for (const link of this.links ?? []) unwatchShortening(link);
    this.links = [...kept, ...added];
    const items = this.links.map((link, index) => {
      const item = make(this, "li", "prism-breadcrumbs-item");
      if (index > 0) item.append(make(this, "prism-icon", "prism-breadcrumbs-separator", { name: "chevron-right", size: "xs" }));
      setAttribute(link, "aria-current", index === this.links.length - 1 ? "page" : null);
      link.classList.add("prism-breadcrumbs-link");
      item.append(link);
      return item;
    });
    this.list.replaceChildren(...items);
    this.observer?.disconnect();
    this.replaceChildren(this.list);
    if (this.isConnected) this.observer?.observe(this, { childList: true });
    for (const link of this.links) watchShortening(link, link, { focusable: () => true });
    requestAnimationFrame(() => this.showEnd());
  }

  /** Scrolls a trail that does not fit to its end. */
  showEnd() {
    if (this.list.scrollWidth > this.list.clientWidth) this.list.scrollLeft = this.list.scrollWidth;
  }
}
