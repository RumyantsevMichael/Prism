// prism-kbd: a key or a key combination drawn as a keycap, such as the shortcut hint of a button, a menu, or a dialog.
import { Base, shadow } from "./base.js";

export class PrismKbd extends Base {
  static tag = "prism-kbd";
  static styles = ["prism-kbd.css"];
  static catalog = {
    purpose: "A key or a key combination drawn as a keycap, for the shortcut hint of a button, a menu, or a dialog; static text that is never a control.",
    options: [
      { name: "keys", values: ["text"], default: "", description: "The keys as the hint shows them, such as Ctrl K; without it the element's own text is shown." }
    ],
    states: ["key", "combination"],
    keyboard: ["A keycap only names a key; the control it describes takes the key."]
  };

  static observedAttributes = ["keys"];

  constructor() {
    super();
    this.root = shadow(this, PrismKbd.styles, `<kbd part="key"><slot></slot></kbd>`);
  }

  connectedCallback() {
    this.sync();
  }

  attributeChangedCallback() {
    this.sync();
  }

  sync() {
    const keys = this.getAttribute("keys");
    if (keys !== null && this.textContent !== keys) this.textContent = keys;
  }
}
