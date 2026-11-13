// prism-canvas: a scrolling canvas in light DOM that draws a drawing, such as a graph or a diagram, on a dotted grid, as diagram editors do.
// The grid follows the drawing: its spacing scales with the drawing's zoom, it is anchored at the drawing's corner, and it scrolls with the drawing when panned.
import { Base } from "./base.js";

// The grid's spacing stays inside one band of the base spacing: zooming out past it merges every other line, zooming in splits each cell, so the dots keep a readable density.
const STEP_LOW = 0.75;
const STEP_HIGH = 1.5;

/** The grid's spacing as a multiple of the base spacing for a zoom, kept between STEP_LOW and STEP_HIGH by halving or doubling, so every coarser grid point stays a point of the finer grid. */
export function canvasStep(scale) {
  let step = Number.isFinite(scale) && scale > 0 ? scale : 1;
  while (step < STEP_LOW) step *= 2;
  while (step >= STEP_HIGH) step /= 2;
  return step;
}

export class PrismCanvas extends Base {
  static tag = "prism-canvas";
  static observedAttributes = ["scale"];
  static catalog = {
    purpose: "A scrolling canvas that draws a graph or a diagram on a dotted grid; the grid scales with the drawing's zoom, starts at the drawing's corner, and moves with it when panned.",
    options: [
      { name: "scale", values: ["number"], default: "1", description: "The drawing's zoom; the grid's spacing follows it, halving or doubling to keep a readable density." },
      { name: "pannable", values: ["boolean"], default: "false", description: "The page pans the canvas by dragging, so the canvas shows a grab cursor and its text cannot be selected." },
      { name: "paint()", values: ["method"], default: "", description: "Places the grid at the drawing's corner again; the canvas calls it when it resizes, its drawing changes, or its scale changes." }
    ],
    states: ["default", "zoomed-out", "zoomed-in", "pannable", "empty"],
    keyboard: ["The canvas is not a control; a page that pans it handles its own keys."]
  };

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

  /** Scales the grid to the zoom and anchors it at the drawing's corner, measured in the canvas's scrolled content. */
  paint() {
    this.style.setProperty("--prism-canvas-step", String(canvasStep(this.scale)));
    const drawing = this.drawing;
    if (!drawing) return;
    const frame = this.getBoundingClientRect();
    const box = drawing.getBoundingClientRect();
    this.style.setProperty("--prism-canvas-x", `${box.left - frame.left - this.clientLeft + this.scrollLeft}px`);
    this.style.setProperty("--prism-canvas-y", `${box.top - frame.top - this.clientTop + this.scrollTop}px`);
  }
}
