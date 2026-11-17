// prism-resizer: the handle on a panel's edge that sets the panel's width, in light DOM: drag it, move it with the arrow keys, or double-click it to return to the default.
// It only reports widths, in whole pixels; the page applies them, so a page can cap a width by the window's size and keep it as the person's preference.
import { Base, emit, setAttribute } from "./base.js";

const STEP = 16;

export class PrismResizer extends Base {
  static tag = "prism-resizer";
  static observedAttributes = ["label", "edge", "min", "max", "value"];
  static catalog = {
    purpose: "The handle on a panel's edge that sets the panel's width: dragging it, the arrow keys, and a double click to return to the default report the new width, and the page applies it, such as the sidebar's and the side panel's.",
    options: [
      { name: "label", values: ["text"], default: "Resize", description: "The handle's accessible name, such as Resize the sidebar." },
      { name: "edge", values: ["end", "start"], default: "end", description: "The panel's edge the handle sits on: end for a panel at the window's start, such as the sidebar, and start for one at its end, such as the side panel." },
      { name: "min", values: ["number"], default: "", description: "The smallest width in pixels, which the handle reports as its minimum." },
      { name: "max", values: ["number"], default: "", description: "The largest width in pixels, which the handle reports as its maximum." },
      { name: "value", values: ["number"], default: "", description: "The panel's width now, in pixels, set by the page." }
    ],
    states: ["default", "start", "hover"],
    keyboard: ["The handle is in the Tab order.", "ArrowLeft and ArrowRight make the panel 16 pixels narrower or wider.", "Home and End set the minimum and the maximum width.", "Enter returns to the default width, as a double click does."]
  };

  constructor() {
    super();
    this.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.addEventListener("dblclick", () => emit(this, "prism-resize-reset"));
    this.addEventListener("keydown", (event) => this.onKey(event));
  }

  connectedCallback() {
    setAttribute(this, "role", "separator");
    setAttribute(this, "aria-orientation", "vertical");
    if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "0");
    this.sync();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.sync();
  }

  sync() {
    setAttribute(this, "aria-label", this.getAttribute("label") || "Resize");
    setAttribute(this, "aria-valuemin", this.getAttribute("min"));
    setAttribute(this, "aria-valuemax", this.getAttribute("max"));
    setAttribute(this, "aria-valuenow", this.getAttribute("value"));
    if (!this.hasAttribute("tip")) this.setAttribute("tip", "Drag to resize · double-click to reset");
  }

  // The width the page set, or the panel's own width when it set none; the panel is the handle's parent.
  current() {
    return Number(this.getAttribute("value")) || Math.round(this.parentElement.getBoundingClientRect().width);
  }

  clamp(width) {
    const min = Number(this.getAttribute("min"));
    const max = Number(this.getAttribute("max"));
    let value = width;
    if (this.hasAttribute("min") && Number.isFinite(min)) value = Math.max(value, min);
    if (this.hasAttribute("max") && Number.isFinite(max)) value = Math.min(value, max);
    return value;
  }

  // A pointer's position has fractions of a pixel, and a width is a whole number of pixels, which the page stores as the person's preference.
  report(width, done) {
    emit(this, "prism-resize", { width: Math.round(this.clamp(width)), done });
  }

  onPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    this.setPointerCapture?.(event.pointerId);
    this.toggleAttribute("dragging", true);
    // A drag moves the width by as far as the pointer moves, so a press without a move changes nothing, wherever on the handle it lands.
    const [startX, start] = [event.clientX, this.current()];
    const widthAt = (clientX) => start + (this.getAttribute("edge") === "start" ? startX - clientX : clientX - startX);
    const move = (next) => this.report(widthAt(next.clientX), false);
    const stop = (last) => {
      this.removeEventListener("pointermove", move);
      this.removeEventListener("pointerup", stop);
      this.removeEventListener("pointercancel", stop);
      this.toggleAttribute("dragging", false);
      this.report(widthAt(last.clientX), true);
    };
    this.addEventListener("pointermove", move);
    this.addEventListener("pointerup", stop);
    this.addEventListener("pointercancel", stop);
  }

  onKey(event) {
    const current = this.current();
    const wider = this.getAttribute("edge") === "start" ? "ArrowLeft" : "ArrowRight";
    const narrower = wider === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
    let width = null;
    if (event.key === wider) width = current + STEP;
    else if (event.key === narrower) width = current - STEP;
    else if (event.key === "Home") width = Number(this.getAttribute("min")) || current;
    else if (event.key === "End") width = Number(this.getAttribute("max")) || current;
    else if (event.key === "Enter") {
      event.preventDefault();
      emit(this, "prism-resize-reset");
      return;
    }
    if (width === null) return;
    event.preventDefault();
    this.report(width, true);
  }
}
