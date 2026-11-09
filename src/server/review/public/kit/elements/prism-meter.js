// prism-meter: a thin progress bar from 0 to 100 with the role progressbar.
import { Base, setAttribute, shadow } from "./base.js";

export class PrismMeter extends Base {
  static tag = "prism-meter";
  static styles = ["prism-meter.css"];
  static observedAttributes = ["value", "label", "tone"];
  static catalog = {
    purpose: "A thin progress bar from 0 to 100, with no value while the progress is unknown.",
    options: [
      { name: "value", values: ["0 to 100"], default: "", description: "The progress in percent; without it the meter has no aria-valuenow." },
      { name: "label", values: ["text"], default: "", description: "The meter's accessible name." },
      { name: "tone", values: ["accent", "danger", "warning", "success", "info"], default: "accent", description: "The fill color." }
    ],
    states: ["empty", "partial", "full", "unknown"],
    keyboard: []
  };

  constructor() {
    super();
    this.root = shadow(this, PrismMeter.styles, `<span class="track" part="track"><span class="fill" part="fill"></span></span>`);
  }

  connectedCallback() {
    setAttribute(this, "role", "progressbar");
    this.sync();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.sync();
  }

  sync() {
    const raw = this.getAttribute("value");
    const number = raw === null || raw === "" ? NaN : Number(raw);
    const known = Number.isFinite(number);
    const value = known ? Math.min(100, Math.max(0, number)) : 0;
    setAttribute(this, "aria-valuemin", "0");
    setAttribute(this, "aria-valuemax", "100");
    setAttribute(this, "aria-valuenow", known ? String(Math.round(value)) : null);
    setAttribute(this, "aria-label", this.getAttribute("label") || null);
    this.root.querySelector(".fill").style.setProperty("--meter-value", `${value}%`);
  }
}
