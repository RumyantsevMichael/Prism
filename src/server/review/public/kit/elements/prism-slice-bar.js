// prism-slice-bar: one segment per slice in the color of the slice's status class, and a label such as "1 of 5 done", as one image for assistive technology.
import { Base, setAttribute, shadow } from "./base.js";
import { STATUSES, statusOf } from "../statuses.js";

// The segments read as progress: done first, then the work under way, then what waits, and what has not started last.
const ORDER = ["done", "active", "waiting", "problem", "ready", "idle", "retired"];

export class PrismSliceBar extends Base {
  static tag = "prism-slice-bar";
  static styles = ["prism-slice-bar.css"];
  static observedAttributes = ["statuses", "label", "tip"];
  static catalog = {
    purpose: "The slices of an initiative as one segment each in the color of the slice's status, the same palette as prism-status, ordered from done to not started so the bar reads as progress, with a label such as 1 of 5 done.",
    options: [
      { name: "statuses", values: ["comma-separated statuses"], default: "", description: `One status per slice, such as ${Object.keys(STATUSES).slice(0, 4).join(", ")}; each segment takes its class's color, and an idle one draws the strong line.` },
      { name: "label", values: ["text"], default: "", description: "The text after the bar, which is also the bar's accessible name." }
    ],
    states: ["default", "not-started", "done"],
    keyboard: []
  };

  constructor() {
    super();
    this.root = shadow(this, PrismSliceBar.styles, `<span class="bar" part="bar"></span><span class="label" part="label"></span>`);
  }

  connectedCallback() {
    setAttribute(this, "role", "img");
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const raw = this.getAttribute("statuses") ?? "";
    const rank = (status) => ORDER.indexOf(statusOf(status).cls);
    const statuses = (raw === "" ? [] : raw.split(",").map((status) => status.trim())).map((status, index) => ({ status, index }))
      .sort((left, right) => rank(left.status) - rank(right.status) || left.index - right.index).map(({ status }) => status);
    this.root.querySelector(".bar").replaceChildren(...statuses.map((status) => {
      const segment = this.ownerDocument.createElement("prism-status");
      segment.setAttribute("value", status);
      segment.setAttribute("variant", "segment");
      segment.setAttribute("glyph-only", "");
      segment.setAttribute("aria-hidden", "true");
      return segment;
    }));
    const label = this.getAttribute("label") ?? "";
    this.root.querySelector(".label").textContent = label;
    setAttribute(this, "aria-label", label || null);
  }
}
