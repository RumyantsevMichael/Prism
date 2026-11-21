// Generated from src/server/review/public/kit/elements/prism-canvas.ts by scripts/native-build/compile.mjs.
import { Base } from "./base.js";
const STEP_LOW = 0.75;
const STEP_HIGH = 1.5;
const CONTROLS = "a, button, input, select, textarea, [role='link'], [role='button']";
function canvasStep(scale) {
  let step = Number.isFinite(scale) && scale > 0 ? scale : 1;
  while (step < STEP_LOW) step *= 2;
  while (step >= STEP_HIGH) step /= 2;
  return step;
}
class PrismCanvas extends Base {
  static tag = "prism-canvas";
  static observedAttributes = ["scale"];
  static catalog = {
    purpose: "A scrolling canvas that draws a graph or a diagram on a dotted grid; the grid scales with the drawing's zoom, starts at the drawing's corner, and moves with it when panned.",
    options: [
      { name: "scale", values: ["number"], default: "1", description: "The drawing's zoom; the grid's spacing follows it, halving or doubling to keep a readable density." },
      { name: "pannable", values: ["boolean"], default: "false", description: "A mouse or pen drags the drawing to pan it, from anywhere but a link or control in it, and moves the box that scrolls the canvas when the canvas grows with the drawing's height; touch pans it by the browser's own scrolling; its text cannot be selected, and it shows a grab cursor while the drawing is larger than the canvas." },
      { name: "overflowing", values: ["boolean"], default: "false", description: "Set by the canvas while its drawing is larger than its frame, so there is something to pan." },
      { name: "panning", values: ["boolean"], default: "false", description: "Set by the canvas while a drag pans it, which shows a grabbing cursor." },
      { name: "paint()", values: ["method"], default: "", description: "Places the grid at the drawing's corner again; the canvas calls it when it resizes, its drawing changes, or its scale changes." }
    ],
    states: ["default", "zoomed-out", "zoomed-in", "pannable", "empty"],
    keyboard: ["The canvas is not a control; a focused canvas scrolls with the arrow keys as any scrolling box does."]
  };
  constructor() {
    super();
    this.addEventListener("pointerdown", (event) => this.panStart(event));
  }
  connectedCallback() {
    if (!globalThis.ResizeObserver) return this.paint();
    this.resizes ??= new ResizeObserver(() => this.paint());
    this.resizes.observe(this);
    this.changes ??= new MutationObserver(() => this.watchDrawing());
    this.changes.observe(this, { childList: true });
    this.watchDrawing();
  }
  disconnectedCallback() {
    this.resizes?.disconnect();
    this.changes?.disconnect();
    this.watched = null;
    this.panEnd();
  }
  attributeChangedCallback() {
    if (this.isConnected) this.paint();
  }
  get scale() {
    const value = Number(this.getAttribute("scale"));
    return Number.isFinite(value) && value > 0 ? value : 1;
  }
  set scale(value) {
    this.setAttribute("scale", String(value));
  }
  /** The drawing the grid starts at: the canvas's SVG, or its first element. */
  get drawing() {
    return this.querySelector(":scope > svg") ?? this.firstElementChild;
  }
  watchDrawing() {
    const drawing = this.drawing;
    if (drawing !== this.watched) {
      if (this.watched) this.resizes?.unobserve(this.watched);
      this.watched = drawing;
      if (drawing) this.resizes?.observe(drawing);
    }
    this.paint();
  }
  /** Starts a drag that pans the canvas: a mouse's main button or a pen, pressed anywhere but a link or control, while the drawing is larger than the frame; touch keeps the browser's own scrolling, which already pans with a finger. */
  panStart(event) {
    if (!this.hasAttribute("pannable") || this.drag || event.pointerType === "touch" || event.button !== 0) return;
    if (event.target?.closest?.(CONTROLS) || !this.overflows()) return;
    event.preventDefault();
    const outer = this.scrollHeight > this.clientHeight + 1 ? null : this.verticalScroller();
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: this.scrollLeft, top: this.scrollTop, outer, outerTop: outer?.scrollTop ?? 0 };
    this.setPointerCapture?.(event.pointerId);
    this.toggleAttribute("panning", true);
    this.addEventListener("pointermove", this.panMove);
    this.addEventListener("pointerup", this.panEnd);
    this.addEventListener("pointercancel", this.panEnd);
    this.addEventListener("lostpointercapture", this.panEnd);
  }
  // The drawing follows the pointer, so the point under it stays under it as far as the scrolling allows.
  panMove = (event) => {
    if (!this.drag || event.pointerId !== this.drag.id) return;
    this.scrollLeft = this.drag.left - (event.clientX - this.drag.x);
    if (this.drag.outer) this.drag.outer.scrollTop = this.drag.outerTop - (event.clientY - this.drag.y);
    else this.scrollTop = this.drag.top - (event.clientY - this.drag.y);
  };
  /** The nearest box around the canvas that scrolls vertically, or none. */
  verticalScroller() {
    for (let box = this.parentElement; box; box = box.parentElement) {
      if (/auto|scroll|overlay/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight + 1) return box;
    }
    const page = this.ownerDocument.scrollingElement;
    return page && page.scrollHeight > page.clientHeight + 1 ? page : null;
  }
  panEnd = () => {
    if (!this.drag) return;
    this.drag = null;
    this.removeEventListener("pointermove", this.panMove);
    this.removeEventListener("pointerup", this.panEnd);
    this.removeEventListener("pointercancel", this.panEnd);
    this.removeEventListener("lostpointercapture", this.panEnd);
    this.toggleAttribute("panning", false);
  };
  /** Whether the drawing is larger than the canvas's frame, so there is something to pan. */
  overflows() {
    return this.scrollWidth > this.clientWidth + 1 || this.scrollHeight > this.clientHeight + 1;
  }
  /** Scales the grid to the zoom and anchors it at the drawing's corner, measured in the canvas's scrolled content. */
  paint() {
    this.style.setProperty("--prism-canvas-step", String(canvasStep(this.scale)));
    this.toggleAttribute("overflowing", this.overflows());
    const drawing = this.drawing;
    if (!drawing) return;
    const frame = this.getBoundingClientRect();
    const box = drawing.getBoundingClientRect();
    this.style.setProperty("--prism-canvas-x", `${box.left - frame.left - this.clientLeft + this.scrollLeft}px`);
    this.style.setProperty("--prism-canvas-y", `${box.top - frame.top - this.clientTop + this.scrollTop}px`);
  }
}
export {
  PrismCanvas,
  canvasStep
};
