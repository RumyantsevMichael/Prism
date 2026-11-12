// prism-menu: a glass menu that the kit button named by `for` opens, with keyboard movement, radio and checkbox items, and placement inside the window.
// A menu without `for` shows in place, as the catalog shows an open menu.
import { Base, deepActiveElement, emit, setAttribute } from "./base.js";

const open = new Set();
const GAP = "--prism-space-2";

function pixels(element, name) {
  return parseFloat(getComputedStyle(element).getPropertyValue(name)) || 0;
}

export class PrismMenu extends Base {
  static tag = "prism-menu";
  static observedAttributes = ["for", "open", "heading", "keys"];
  static catalog = {
    purpose: "A menu of actions and choices that opens from a kit button, floats on glass, and stays inside the window.",
    options: [
      { name: "for", values: ["id"], default: "", description: "The id of the kit button that opens the menu; the menu sets aria-haspopup and aria-expanded on it. Without it the menu shows in place." },
      { name: "open", values: ["boolean"], default: "false", description: "Whether the menu is open." },
      { name: "heading", values: ["text"], default: "", description: "A title row at the top of the menu, which also names it." },
      { name: "keys", values: ["text"], default: "", description: "The shortcut that opens the menu, shown as a keycap at the end of its title row." },
      { name: "size", values: ["default", "wide"], default: "default", description: "wide takes --prism-menu-width, for a menu of tiles and switches." },
      { name: "sheet", values: ["boolean"], default: "false", description: "At --prism-sheet-width and below, the menu spans the window's width inside its margins, as a sheet over its button." }
    ],
    states: ["closed", "actions", "groups", "titled", "sheet"],
    keyboard: ["Enter, Space, or ArrowDown on the button opens the menu on its first item, and ArrowUp on its last item.", "ArrowUp, ArrowDown, Home, and End move between items; in a group of tiles or segments ArrowLeft and ArrowRight move between its items.", "Enter, Space, or a click chooses an item, sends prism-select, closes the menu, and returns focus to the button.", "Escape closes the menu and returns focus; Tab or a click outside closes it."]
  };

  constructor() {
    super();
    this.onTriggerClick = () => (this.isOpen ? this.close({ focus: true }) : this.show({ focus: "first" }));
    this.onTriggerKey = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.show({ focus: event.key === "ArrowDown" ? "first" : "last" });
      }
    };
    this.onOutside = (event) => {
      const path = event.composedPath();
      if (path.includes(this) || (this.trigger && path.includes(this.trigger))) return;
      this.close();
    };
    this.onViewport = () => this.place();
    this.addEventListener("keydown", (event) => this.onKey(event));
    this.addEventListener("click", (event) => {
      const item = this.itemFrom(event);
      if (item) this.choose(item);
    });
  }

  connectedCallback() {
    setAttribute(this, "role", "menu");
    this.syncTitle();
    this.bind();
    if (!this.trigger && this.hasAttribute("for")) requestAnimationFrame(() => this.bind());
  }

  disconnectedCallback() {
    this.unbind();
    this.stopListening();
    open.delete(this);
  }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    if (name === "heading" || name === "keys") this.syncTitle();
    else if (name === "for") this.bind();
    else if (name === "open" && !this.changing) {
      if (this.hasAttribute("open")) this.show();
      else this.close();
    }
  }

  // The title row: the heading, which also names the menu, and the keycap of its shortcut.
  syncTitle() {
    const heading = this.getAttribute("heading") ?? "";
    const keys = this.getAttribute("keys") ?? "";
    if (!heading && !this.title$) return;
    if (!this.title$) {
      const document = this.ownerDocument;
      this.title$ = document.createElement("div");
      this.title$.className = "prism-menu-title";
      this.title$.setAttribute("aria-hidden", "true");
      this.titleText$ = document.createElement("span");
      this.titleKeys$ = document.createElement("prism-kbd");
      this.title$.append(this.titleText$, this.titleKeys$);
    }
    if (this.firstElementChild !== this.title$) this.prepend(this.title$);
    this.titleText$.textContent = heading;
    this.titleKeys$.textContent = keys;
    this.titleKeys$.hidden = !keys;
    this.title$.hidden = !heading;
    setAttribute(this, "aria-label", heading || null);
  }

  get floating() {
    return this.hasAttribute("for");
  }

  get isOpen() {
    return this.floating ? this.matches(":popover-open") : true;
  }

  get items() {
    return [...this.querySelectorAll("prism-menu-item")].filter((item) => item.closest("prism-menu") === this);
  }

  get enabledItems() {
    return this.items.filter((item) => !item.hasAttribute("disabled"));
  }

  bind() {
    const id = this.getAttribute("for");
    const trigger = id ? this.getRootNode().getElementById?.(id) ?? this.ownerDocument.getElementById(id) : null;
    if (trigger !== this.trigger) this.unbind();
    if (this.floating) {
      setAttribute(this, "popover", "manual");
      if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "-1");
    } else {
      setAttribute(this, "popover", null);
      this.rove(this.enabledItems[0]);
    }
    if (!trigger || trigger === this.trigger) return;
    this.trigger = trigger;
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", String(this.floating && this.isOpen));
    trigger.addEventListener("click", this.onTriggerClick);
    trigger.addEventListener("keydown", this.onTriggerKey);
    if (this.hasAttribute("open")) this.show();
  }

  unbind() {
    if (!this.trigger) return;
    this.trigger.removeEventListener("click", this.onTriggerClick);
    this.trigger.removeEventListener("keydown", this.onTriggerKey);
    this.trigger = null;
  }

  setOpenAttribute(on) {
    this.changing = true;
    this.toggleAttribute("open", on);
    this.changing = false;
  }

  /** Opens the menu, closing every other open menu, and moves focus to its first or last enabled item when `focus` says so. */
  show({ focus } = {}) {
    if (!this.floating) return;
    for (const other of [...open]) if (other !== this) other.close();
    if (!this.isOpen) {
      try {
        this.showPopover();
      } catch {
        return;
      }
    }
    open.add(this);
    this.setOpenAttribute(true);
    this.trigger?.setAttribute("aria-expanded", "true");
    this.place();
    this.listen();
    const items = this.enabledItems;
    const target = focus === "last" ? items.at(-1) : focus === "first" ? items[0] : null;
    this.rove(target ?? items[0]);
    target?.focus();
  }

  /** Closes the menu, returning focus to its button when `focus` is set. */
  close({ focus = false } = {}) {
    if (!this.floating) return;
    if (this.isOpen) {
      try {
        this.hidePopover();
      } catch {
        // A menu that left the document is already hidden.
      }
    }
    open.delete(this);
    this.setOpenAttribute(false);
    this.trigger?.setAttribute("aria-expanded", "false");
    this.stopListening();
    if (focus) this.trigger?.focus();
  }

  listen() {
    if (this.listening) return;
    this.listening = true;
    this.ownerDocument.addEventListener("pointerdown", this.onOutside, true);
    globalThis.addEventListener("resize", this.onViewport);
    globalThis.addEventListener("scroll", this.onViewport, true);
  }

  stopListening() {
    if (!this.listening) return;
    this.listening = false;
    this.ownerDocument.removeEventListener("pointerdown", this.onOutside, true);
    globalThis.removeEventListener("resize", this.onViewport);
    globalThis.removeEventListener("scroll", this.onViewport, true);
  }

  // Below the button when it fits there, above it when there is more room above, and always inside the window.
  place() {
    if (!this.floating || !this.isOpen || !this.trigger) return;
    const anchor = this.trigger.getBoundingClientRect();
    const gap = pixels(this, GAP);
    const margin = pixels(this, "--prism-space-3");
    this.style.removeProperty("max-height");
    const width = globalThis.innerWidth;
    const height = globalThis.innerHeight;
    // A sheet spans the window inside its margins at the sheet width and below.
    const sheet = this.hasAttribute("sheet") && width <= pixels(this, "--prism-sheet-width");
    if (sheet) this.style.setProperty("width", `${Math.max(0, width - 2 * margin)}px`);
    else this.style.removeProperty("width");
    const below = height - anchor.bottom - gap - margin;
    const above = anchor.top - gap - margin;
    let box = this.getBoundingClientRect();
    const downward = box.height <= below || below >= above;
    const room = Math.max(0, downward ? below : above);
    if (box.height > room) this.style.setProperty("max-height", `${room}px`);
    box = this.getBoundingClientRect();
    const top = downward ? anchor.bottom + gap : anchor.top - gap - box.height;
    const left = Math.min(Math.max(margin, anchor.left), Math.max(margin, width - margin - box.width));
    this.style.setProperty("top", `${Math.max(margin, top)}px`);
    this.style.setProperty("left", `${left}px`);
  }

  rove(target) {
    for (const item of this.items) item.setAttribute("tabindex", item === target ? "0" : "-1");
  }

  itemFrom(event) {
    const item = event.composedPath().find((node) => node.tagName === "PRISM-MENU-ITEM");
    return item && item.closest("prism-menu") === this ? item : null;
  }

  /** Checks a radio item and unchecks the others of its group, toggles a checkbox, sends prism-select, and closes the menu. */
  choose(item) {
    if (item.hasAttribute("disabled")) return;
    const type = item.getAttribute("type");
    if (type === "radio") {
      const scope = item.closest("prism-menu-group") ?? this;
      for (const other of scope.querySelectorAll('prism-menu-item[type="radio"]')) other.toggleAttribute("checked", other === item);
    } else if (type === "checkbox") item.toggleAttribute("checked");
    const detail = { value: item.getAttribute("value") ?? "" };
    if (type === "radio" || type === "checkbox") detail.checked = item.hasAttribute("checked");
    const returnFocus = this.contains(deepActiveElement(this.ownerDocument)) || deepActiveElement(this.ownerDocument) === this.ownerDocument.body;
    this.close({ focus: returnFocus });
    emit(this, "prism-select", detail);
  }

  onKey(event) {
    const items = this.enabledItems;
    const current = this.itemFrom(event);
    const index = current ? items.indexOf(current) : -1;
    let next = null;
    switch (event.key) {
      case "ArrowDown":
        next = items[(index + 1) % items.length];
        break;
      case "ArrowUp":
        next = items[(index - 1 + items.length) % items.length];
        break;
      case "ArrowRight":
      case "ArrowLeft": {
        // Tiles and segments sit side by side, so the side arrows move inside their group and wrap at its ends.
        const group = current?.closest("prism-menu-group[layout]");
        if (!group || !["tiles", "segmented"].includes(group.getAttribute("layout"))) return;
        const row = items.filter((item) => item.closest("prism-menu-group") === group);
        const at = row.indexOf(current);
        next = row[(at + (event.key === "ArrowRight" ? 1 : -1) + row.length) % row.length];
        break;
      }
      case "Home":
        next = items[0];
        break;
      case "End":
        next = items.at(-1);
        break;
      case "Enter":
      case " ":
        if (current) {
          event.preventDefault();
          this.choose(current);
        }
        return;
      case "Escape":
        if (this.floating) {
          event.preventDefault();
          event.stopPropagation();
          this.close({ focus: true });
        }
        return;
      case "Tab":
        if (this.floating) {
          // Focus goes back to the button first, so Tab moves on from there.
          this.close({ focus: true });
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    if (!next) return;
    this.rove(next);
    next.focus();
  }
}
