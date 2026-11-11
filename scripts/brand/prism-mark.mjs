// Generates the Prism mark: three congruent triangles around a triangular hole turned by theta.
// A line leaves each outer corner at theta to its edge, so each piece has angles theta, 60 - theta, and 120.
// theta and 60 - theta are mirror images, and theta = 30 closes the hole.
// Run `node scripts/brand/prism-mark.mjs` to rewrite the SVG files in the review app and the plugin icon.
// Rendering the icon needs a global Playwright with Chromium, the same one the browser tests use.
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const MARK = {
  theta: 21, // corner angle in degrees
  gap: 9, // gap between pieces, in units of a circumradius of 100
  lift: 0.55, // 0 centers the bounding box, 1 centers the centroid, which sits h/6 below it
  padding: 0.08, // space around the mark as a share of the canvas side
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const norm = (v) => { const l = Math.hypot(v[0], v[1]); return [v[0] / l, v[1] / l]; };
const rot = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
const intersect = (p, d, q, e) => add(p, mul(d, cross(sub(q, p), e) / cross(d, e)));

function inset(triangle, offsets) {
  const sign = cross(sub(triangle[1], triangle[0]), sub(triangle[2], triangle[0])) > 0 ? 1 : -1;
  const lines = [0, 1, 2].map((i) => {
    const p = triangle[i], d = norm(sub(triangle[(i + 1) % 3], p));
    return [add(p, mul([-d[1] * sign, d[0] * sign], offsets[i])), d];
  });
  return [0, 1, 2].map((i) => intersect(...lines[(i + 2) % 3], ...lines[i]));
}

// The pieces as polygons fitted into a square canvas of the given side.
export function markPolygons(side, { theta, gap, lift, padding } = MARK) {
  const V = [0, 120, 240].map((a) => [100 * Math.sin(a * Math.PI / 180), -100 * Math.cos(a * Math.PI / 180)]);
  const d = [0, 1, 2].map((i) => rot(norm(sub(V[(i + 1) % 3], V[i])), theta * Math.PI / 180));
  const P = [0, 1, 2].map((i) => intersect(V[i], d[i], V[(i + 1) % 3], d[(i + 1) % 3]));
  const pieces = [0, 1, 2].map((i) => inset([V[i], V[(i + 1) % 3], P[i]], [0, gap / 2, gap / 2]));
  const xs = V.map((p) => p[0]), ys = V.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  const k = side * (1 - 2 * padding) / w;
  const ox = side / 2 - (Math.min(...xs) + w / 2) * k;
  const oy = side / 2 - (Math.min(...ys) + h / 2 + lift * h / 6) * k;
  return pieces.map((piece) => piece.map(([x, y]) => [x * k + ox, y * k + oy]));
}

export function markPath(side, options) {
  const f = (v) => String(+v.toFixed(3));
  return markPolygons(side, options).map((piece) => "M" + piece.map(([x, y]) => `${f(x)} ${f(y)}`).join("L") + "Z").join("");
}

// The tab icon keeps a 32 by 32 canvas because the attention badge draws its dot at fixed coordinates.
export function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#ffffff"/>
  <path fill="#111318" d="${markPath(32)}"/>
</svg>
`;
}

// The plugin icon is the tab icon at the size both hosts list plugins at.
// Claude Code wants a square PNG of 512 to 2048 pixels, and Codex reads the same file for its composer icon and logo.
export const ICON_SIDE = 1024;

export function iconSvg(side = ICON_SIDE) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${side}" height="${side}">
  <rect width="${side}" height="${side}" rx="${side * 7 / 32}" fill="#ffffff"/>
  <path fill="#111318" d="${markPath(side)}"/>
</svg>
`;
}

async function renderPng(svg, side) {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: side, height: side } });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
    return await page.screenshot({ omitBackground: true });
  } finally {
    await browser.close();
  }
}

// The color mark spreads a spectrum across the pieces, cool on the side the light enters and warm where it leaves.
export const SPECTRUM = [[0, "#7fe3ff"], [0.22, "#4f8bff"], [0.45, "#7a5cff"], [0.66, "#f062d6"], [0.84, "#ff9a6e"], [1, "#ffd37a"]];

export function gradientMarkSvg(stops = SPECTRUM) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <linearGradient id="prism-mark" x1="0" y1="0.35" x2="1" y2="0.65">
${stops.map(([offset, color]) => `      <stop offset="${offset}" stop-color="${color}"/>`).join("\n")}
    </linearGradient>
  </defs>
  <path fill="url(#prism-mark)" d="${markPath(32, { ...MARK, padding: 0 })}"/>
</svg>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const publicDirectory = new URL("../../src/server/review/public/", import.meta.url);
  await writeFile(new URL("favicon.svg", publicDirectory), faviconSvg());
  await writeFile(new URL("prism-mark.svg", publicDirectory), gradientMarkSvg());
  await writeFile(new URL("../../assets/icon.png", import.meta.url), await renderPng(iconSvg(), ICON_SIDE));
}
