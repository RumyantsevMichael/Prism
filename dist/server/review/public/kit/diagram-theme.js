// themeDiagram: recolors a PlantUML SVG attached to the page so it follows the theme.
// Only the vendored runtime's default colors change, to the --prism-color-diagram-* values computed on the SVG; every color the author set stays,
// except that an author's text on a default ground or the paper, and an author's line, is lightened or darkened with its hue kept until it reads.
import { PLANTUML_DEFAULTS, PLANTUML_TEXT } from "./plantuml-defaults.js";

const ROLES = ["paper", "ink", "line", "surface", "surface-2", "group", "group-line", "note", "note-line", "danger"];
const SHAPES = "rect, path, polygon, ellipse, circle";
const STROKED = "rect, path, polygon, ellipse, circle, line, polyline";
const TEXT_RATIO = 4.5;
const LINE_RATIO = 3;
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

let paint = null;

// Any CSS color as [r, g, b, a] with a in 0..1, read through a canvas so every color syntax a token may use works.
function channels(color) {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(String(color).trim())?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const values = [0, 2, 4, 6].map((at) => Number.parseInt(full.slice(at, at + 2) || "ff", 16));
    return [values[0], values[1], values[2], values[3] / 255];
  }
  paint ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  paint.clearRect(0, 0, 1, 1);
  paint.fillStyle = "transparent";
  paint.fillStyle = color;
  paint.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

const toHex = ([r, g, b]) => `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

const luminance = ([r, g, b]) => [r, g, b]
  .map((value) => value / 255)
  .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);

function contrast(left, right) {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

// Moves a color toward white or black, whichever the ground contrasts with more, until it reaches the ratio; mixing with white or black keeps its hue.
function lift(color, ground, ratio) {
  const rgb = channels(color);
  if (contrast(rgb, ground) >= ratio) return color;
  const end = contrast(WHITE, ground) >= contrast(BLACK, ground) ? WHITE : BLACK;
  for (let step = 1; step <= 50; step += 1) {
    const mix = rgb.slice(0, 3).map((value, index) => value + (end[index] - value) * (step / 50));
    if (contrast(mix, ground) >= ratio) return toHex(mix);
  }
  return toHex(end);
}

const upper = (value) => (value ?? "").trim().toUpperCase();
const isColor = (value) => value.startsWith("#") && channels(value)[3] > 0;
const roleOf = (value) => (Object.hasOwn(PLANTUML_DEFAULTS, value) ? PLANTUML_DEFAULTS[value] : undefined);

function box(element) {
  try {
    return element.getBBox();
  } catch {
    return null;
  }
}

/** Recolors `svg`, attached to the page, from the diagram tokens computed on it; call it on a fresh copy of the runtime's SVG each time. */
export function themeDiagram(svg) {
  if (!svg?.isConnected) return;
  const style = getComputedStyle(svg);
  const palette = Object.fromEntries(ROLES.map((role) => [role, toHex(channels(style.getPropertyValue(`--prism-color-diagram-${role}`).trim() || "transparent"))]));
  const paper = channels(palette.paper);
  const order = new Map([...svg.querySelectorAll("*")].map((element, index) => [element, index]));

  // The ground each shape gives the text drawn over it, read before anything is recolored: a default fill in its new color, or the author's fill.
  const grounds = [];
  for (const shape of svg.querySelectorAll(SHAPES)) {
    const fill = upper(shape.getAttribute("fill"));
    const role = roleOf(fill);
    if (!isColor(fill) || role === "line") continue;
    const ground = role ? { by: "default", color: channels(palette[role]) } : role === undefined ? { by: "author", color: channels(fill) } : null;
    const bounds = ground && box(shape);
    if (bounds) grounds.push({ shape, bounds, ...ground });
  }
  const groundOf = (text) => {
    const bounds = box(text);
    if (!bounds) return null;
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    let under = null;
    for (const ground of grounds) {
      if (order.get(ground.shape) > order.get(text)) break;
      const { x: left, y: top, width, height } = ground.bounds;
      if (x >= left && x <= left + width && y >= top && y <= top + height) under = ground;
    }
    return under;
  };

  // Text first, while every ground still has its runtime color.
  const texts = [...svg.querySelectorAll("text")].map((text) => [text, upper(text.getAttribute("fill")), groundOf(text)]);
  for (const [text, fill, ground] of texts) {
    if (!isColor(fill)) continue;
    if (fill === PLANTUML_TEXT) {
      const keep = ground?.by === "author" && contrast(BLACK, ground.color) >= TEXT_RATIO;
      if (!keep) text.setAttribute("fill", palette.ink);
    } else if (roleOf(fill)) {
      text.setAttribute("fill", palette.ink);
    } else if (ground?.by !== "author") {
      text.setAttribute("fill", lift(fill, ground?.color ?? paper, TEXT_RATIO));
    }
  }

  for (const element of svg.querySelectorAll(STROKED)) {
    const fill = upper(element.getAttribute("fill"));
    const stroke = upper(element.getAttribute("stroke"));
    const fillRole = roleOf(fill);
    const strokeRole = roleOf(stroke);
    if (fillRole) element.setAttribute("fill", palette[fillRole]);
    if (strokeRole) {
      element.setAttribute("stroke", palette[fillRole === "note" ? "note-line" : strokeRole]);
    } else if (isColor(stroke)) {
      // A line the author colored, or the runtime's black, stays its own hue and reaches 3:1 on the paper; an arrowhead filled with its line's color follows it.
      const lifted = lift(stroke, paper, LINE_RATIO);
      if (lifted !== stroke) {
        element.setAttribute("stroke", lifted);
        if (fill === stroke && element.tagName.toLowerCase() === "polygon") element.setAttribute("fill", lifted);
      }
    }
  }
}
