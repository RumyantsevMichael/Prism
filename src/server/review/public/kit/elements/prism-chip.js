// prism-chip: a short label in a tone; static text, a link with href, or a button with interactive.
import { Base, setAttribute, shadow } from "./base.js";
import { remeasure, unwatchShortening, watchShortening } from "../shorten.js";

export const TONES = Object.freeze(["neutral", "accent", "danger", "warning", "success", "info"]);

export class PrismChip extends Base {
  static tag = "prism-chip";
  static styles = ["prism-chip.css"];
  static observedAttributes = ["href", "interactive", "target", "label"];
  static catalog = {
    purpose: "A short label in a tone, with quieter secondary text from slot=\"meta\"; static text, a link with href, or a button with interactive.",
    options: [
      { name: "tone", values: TONES, default: "neutral", description: "The color of the chip; the text stays at 4.5:1 on its soft fill." },
      { name: "href", values: ["URL"], default: "", description: "Makes the chip a link to that address." },
      { name: "interactive", values: ["boolean"], default: "false", description: "Makes the chip a button that sends click." },
      { name: "label", values: ["text"], default: "", description: "The accessible name of a link or button chip whose text alone does not say what it does." },
      { name: "slot=\"meta\"", values: ["children"], default: "", description: "Secondary text shown after the label, such as a count or a kind." },
      { name: "tip", values: ["text"], default: "", description: "A short description the kit tooltip shows on hover and keyboard focus." }
    ],
    states: ["static", "tones", "link", "interactive", "meta"],
    keyboard: ["A link chip opens with Enter and a button chip activates with Enter and Space.", "A static chip whose text is shortened joins the Tab order so its full text can be read."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismChip.styles, "");
    this.render();
  }

  connectedCallback() {
    watchShortening(this, this.text, { focusable: () => this.mode !== "static" });
  }

  disconnectedCallback() {
    unwatchShortening(this);
  }

  attributeChangedCallback(name) {
    if (name === "label") {
      if (this.control) setAttribute(this.control, "aria-label", this.getAttribute("label") || null);
      return;
    }
    this.render();
    if (this.isConnected) watchShortening(this, this.text, { focusable: () => this.mode !== "static" });
  }

  get mode() {
    return this.hasAttribute("href") ? "link" : this.hasAttribute("interactive") ? "button" : "static";
  }

  render() {
    const mode = this.mode;
    if (this.control && this.rendered === mode) {
      if (mode === "link") this.control.setAttribute("href", this.getAttribute("href"));
      return;
    }
    this.rendered = mode;
    const inner = `<span class="text"><slot></slot></span><span class="meta" hidden><slot name="meta"></slot></span>`;
    this.root.innerHTML = mode === "link"
      ? `<a class="chip" part="chip">${inner}</a>`
      : mode === "button"
        ? `<button class="chip" part="chip" type="button">${inner}</button>`
        : `<span class="chip" part="chip">${inner}</span>`;
    this.control = mode === "static" ? null : this.root.querySelector(".chip");
    this.text = this.root.querySelector(".text");
    // The meta part shows only when a child fills slot="meta".
    const meta = this.root.querySelector(".meta");
    const slot = meta.querySelector("slot");
    const showMeta = () => { meta.hidden = !slot.assignedNodes().length; };
    slot.addEventListener("slotchange", showMeta);
    showMeta();
    if (mode === "link") {
      this.control.setAttribute("href", this.getAttribute("href"));
      const target = this.getAttribute("target");
      if (target) {
        this.control.setAttribute("target", target);
        this.control.setAttribute("rel", "noopener");
      }
    }
    if (this.control) setAttribute(this.control, "aria-label", this.getAttribute("label") || null);
    if (this.isConnected) remeasure(this);
  }
}
