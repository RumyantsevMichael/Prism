// prism-menu-item: one item of a prism-menu, an action, a radio choice, or a checkbox.
import { Base, setAttribute, shadow } from "./base.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

const ROLES = { action: "menuitem", radio: "menuitemradio", checkbox: "menuitemcheckbox" };

export class PrismMenuItem extends Base {
  static tag = "prism-menu-item";
  static styles = ["prism-menu-item.css"];
  static observedAttributes = ["type", "checked", "disabled", "variant", "preview"];
  static catalog = {
    purpose: "One item of a prism-menu: an action, a radio choice among the items of its group, or a checkbox.",
    options: [
      { name: "value", values: ["text"], default: "", description: "The value the menu sends in prism-select when this item is chosen." },
      { name: "type", values: ["action", "radio", "checkbox"], default: "action", description: "The item's role: menuitem, menuitemradio, or menuitemcheckbox." },
      { name: "checked", values: ["boolean"], default: "false", description: "Whether a radio or checkbox item is checked, exposed as aria-checked." },
      { name: "disabled", values: ["boolean"], default: "false", description: "The item cannot be chosen and arrow keys skip it." },
      { name: "slot=\"hint\"", values: ["children"], default: "", description: "Quieter text at the end of the item, such as a shortcut." },
      { name: "slot=\"detail\"", values: ["children"], default: "", description: "A second, quieter line under the item's text, such as a folder path; it ends with an ellipsis when it does not fit." },
      { name: "variant", values: ["row", "tile", "segment"], default: "row", description: "row is a line of the menu; tile draws a choice as a preview over its name, and segment as one option of a segmented switch, both inside a prism-menu-group of that layout." },
      { name: "preview", values: ["system", "light", "dark"], default: "", description: "A tile's preview: a small window drawn in that theme's own tokens, or light and dark side by side for system." }
    ],
    states: ["action", "radio", "checked", "checkbox", "disabled", "hint", "detail", "tile", "segment"],
    keyboard: ["Inside an open menu, arrow keys move between items and Enter or Space chooses one.", "In a group of tiles or segments, ArrowLeft and ArrowRight also move between its items."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismMenuItem.styles, `<span class="item" part="item"><slot name="preview"></slot><span class="check" aria-hidden="true"><prism-icon name="check" size="sm"></prism-icon></span><span class="body"><span class="text"><slot></slot></span><span class="detail"><slot name="detail"></slot></span></span><span class="hint"><slot name="hint"></slot></span></span>`);
  }

  connectedCallback() {
    this.root.querySelector('slot[name="detail"]').addEventListener("slotchange", () => this.sync());
    this.sync();
    if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "-1");
    watchShortening(this, this.root.querySelector(".text"), { focusable: () => true });
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  attributeChangedCallback() {
    if (this.isConnected) this.sync();
  }

  get type() {
    const type = this.getAttribute("type");
    return ROLES[type] ? type : "action";
  }

  get value() {
    return this.getAttribute("value") ?? "";
  }

  get checked() {
    return this.hasAttribute("checked");
  }

  set checked(value) {
    this.toggleAttribute("checked", Boolean(value));
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  // A tile's preview is light-DOM content, so the theme it names applies to it through the page's tokens.
  syncPreview() {
    const theme = this.getAttribute("variant") === "tile" ? this.getAttribute("preview") : null;
    const current = this.querySelector(":scope > [slot=preview]");
    if (current?.dataset.preview === (theme ?? "")) return;
    current?.remove();
    if (!["system", "light", "dark"].includes(theme)) return;
    const document = this.ownerDocument;
    const span = (className) => {
      const node = document.createElement("span");
      node.className = className;
      return node;
    };
    const window = (name) => {
      const preview = span("prism-theme-preview");
      preview.dataset.theme = name;
      const side = span("prism-theme-preview-side");
      side.append(span("prism-theme-preview-line is-on"), span("prism-theme-preview-line"), span("prism-theme-preview-line"));
      preview.append(side, span("prism-theme-preview-page"));
      return preview;
    };
    const holder = theme === "system" ? span("prism-theme-preview-split") : window(theme);
    if (theme === "system") holder.append(window("light"), window("dark"));
    holder.slot = "preview";
    holder.dataset.preview = theme;
    holder.setAttribute("aria-hidden", "true");
    this.prepend(holder);
  }

  sync() {
    this.syncPreview();
    this.toggleAttribute("detailed", Boolean(this.querySelector(":scope > [slot=detail]")));
    const type = this.type;
    setAttribute(this, "role", ROLES[type]);
    setAttribute(this, "aria-checked", type === "action" ? null : String(this.checked));
    setAttribute(this, "aria-disabled", this.disabled ? "true" : null);
  }
}
