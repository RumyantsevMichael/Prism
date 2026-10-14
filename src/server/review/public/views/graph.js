import { escapeHtml } from "./util.js";

const SVG = "http://www.w3.org/2000/svg";
const POINTS_PER_INCH = 72;
const NODE_PADDING_X = 14;
const NODE_HEIGHT = 46;
const NODE_MAX_WIDTH = 340;
let vizInstance;
let measureContext;

function viz() {
  if (!window.Viz) {
    throw new Error("The Graphviz layout engine is not loaded.");
  }
  vizInstance ??= window.Viz.instance();
  return vizInstance;
}

function textWidth(text, font) {
  measureContext ??= document.createElement("canvas").getContext("2d");
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

function nodeWidth(node) {
  // Measure with the font the node box actually renders, plus the border and a safety margin for font fallback.
  const family = getComputedStyle(document.body).fontFamily;
  const title = textWidth(node.title ?? "", `600 13px ${family}`);
  const mono = textWidth(node.title ?? "", "500 12px ui-monospace, SFMono-Regular, Menlo, monospace");
  const subtitle = textWidth(node.subtitle ?? "", `11px ${family}`);
  const widest = Math.max(node.monospace ? mono : title, subtitle);
  return Math.min(NODE_MAX_WIDTH, Math.max(90, Math.ceil(widest * 1.06) + NODE_PADDING_X * 2 + 10));
}

function quote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function buildDot(graph, names) {
  const lines = [
    "digraph G {",
    `graph [rankdir=${graph.rankdir ?? "LR"}, newrank=true, nodesep=0.22, ranksep=0.9, pad=0.2, splines=true];`,
    'node [shape=box, fixedsize=true, label=""];',
    "edge [arrowhead=none];"
  ];
  const byCluster = new Map();
  for (const node of graph.nodes) {
    const key = node.cluster ?? "";
    if (!byCluster.has(key)) {
      byCluster.set(key, []);
    }
    byCluster.get(key).push(node);
  }
  const clusterNames = new Map();
  for (const [clusterId, nodes] of byCluster) {
    const declarations = nodes.map((node) => `${names.get(node.id)} [width=${(node.width / POINTS_PER_INCH).toFixed(3)}, height=${(NODE_HEIGHT / POINTS_PER_INCH).toFixed(3)}];`);
    if (clusterId) {
      const name = `cluster_${clusterNames.size}`;
      clusterNames.set(name, clusterId);
      lines.push(`subgraph ${name} { graph [label=${quote(" ")}, margin=14]; ${declarations.join(" ")} }`);
    } else {
      lines.push(...declarations);
    }
  }
  for (const group of graph.sameRank ?? []) {
    const members = group.filter((id) => names.has(id)).map((id) => names.get(id));
    if (members.length > 1) {
      lines.push(`{ rank=same; ${members.join("; ")}; }`);
    }
  }
  graph.edges.forEach((edge) => {
    if (names.has(edge.from) && names.has(edge.to)) {
      lines.push(`${names.get(edge.from)} -> ${names.get(edge.to)};`);
    }
  });
  lines.push("}");
  return { dot: lines.join("\n"), clusterNames };
}

function parsePoint(value) {
  const [x, y] = value.split(",").map(Number);
  return { x, y };
}

function edgePath(pos, flip) {
  const points = pos.split(/\s+/).filter((part) => part && !part.startsWith("e,") && !part.startsWith("s,")).map(parsePoint).map(flip);
  if (points.length === 0) {
    return "";
  }
  let path = `M${points[0].x},${points[0].y}`;
  for (let index = 1; index + 2 < points.length; index += 3) {
    path += ` C${points[index].x},${points[index].y} ${points[index + 1].x},${points[index + 1].y} ${points[index + 2].x},${points[index + 2].y}`;
  }
  return path;
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

// Lay out with Graphviz, then draw every node and edge ourselves so styling and interaction stay in our hands.
export async function renderGraph(target, graph, { onSelect, selectedId = null, clusterLabels = new Map() } = {}) {
  const nodes = graph.nodes.map((node) => ({ ...node, width: nodeWidth(node) }));
  const names = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const ids = new Map([...names].map(([id, name]) => [name, id]));
  const { dot, clusterNames } = buildDot({ ...graph, nodes }, names);
  const layout = (await viz()).renderJSON(dot);
  const [, , width, height] = layout.bb.split(",").map(Number);
  const flip = ({ x, y }) => ({ x, y: height - y });
  const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, width, height, class: "graph-svg", role: "img", "aria-label": graph.label ?? "Graph" });
  const clusters = svgElement("g", { class: "graph-clusters" });
  const edges = svgElement("g", { class: "graph-edges" });
  const nodeLayer = svgElement("g", { class: "graph-nodes" });
  svg.append(clusters, edges, nodeLayer);

  for (const object of layout.objects ?? []) {
    if (object.name?.startsWith("cluster_") && object.bb) {
      const [x1, y1, x2, y2] = object.bb.split(",").map(Number);
      const clusterId = clusterNames.get(object.name);
      const group = svgElement("g", { class: "graph-cluster" });
      group.append(svgElement("rect", { x: x1, y: height - y2, width: x2 - x1, height: y2 - y1, rx: 10 }));
      const label = svgElement("text", { x: x1 + 10, y: height - y2 + 14 });
      label.textContent = clusterLabels.get(clusterId) ?? clusterId;
      group.append(label);
      clusters.append(group);
    }
  }

  const edgeElements = [];
  const objects = layout.objects ?? [];
  for (const edge of layout.edges ?? []) {
    const from = ids.get(objects[edge.tail]?.name);
    const to = ids.get(objects[edge.head]?.name);
    const source = graph.edges.find((item) => item.from === from && item.to === to);
    const element = svgElement("path", { d: edgePath(edge.pos ?? "", flip), class: `graph-edge ${source?.className ?? ""}` });
    element.dataset.from = from;
    element.dataset.to = to;
    edges.append(element);
    edgeElements.push(element);
  }

  const nodeElements = new Map();
  for (const object of objects) {
    const id = ids.get(object.name);
    if (!id || !object.pos) {
      continue;
    }
    const node = nodes.find((item) => item.id === id);
    const center = flip(parsePoint(object.pos));
    const nodeWidthPoints = Number(object.width) * POINTS_PER_INCH;
    const nodeHeightPoints = Number(object.height) * POINTS_PER_INCH;
    const group = svgElement("g", { class: `graph-node ${node.className ?? ""}`, tabindex: 0, role: "button", "aria-label": `${node.title}${node.subtitle ? `, ${node.subtitle}` : ""}` });
    group.dataset.id = id;
    const box = svgElement("foreignObject", { x: center.x - nodeWidthPoints / 2, y: center.y - nodeHeightPoints / 2, width: nodeWidthPoints, height: nodeHeightPoints });
    box.innerHTML = `<div xmlns="http://www.w3.org/1999/xhtml" class="graph-node-box" title="${escapeHtml(node.tooltip ?? node.title)}"><strong>${escapeHtml(node.title)}</strong>${node.subtitle ? `<span>${escapeHtml(node.subtitle)}</span>` : ""}</div>`;
    group.append(box);
    group.addEventListener("click", (event) => onSelect?.(id, { keep: event.ctrlKey || event.metaKey }));
    group.addEventListener("dblclick", () => onSelect?.(id, { keep: true, double: true }));
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect?.(id, { keep: event.ctrlKey || event.metaKey });
      }
    });
    group.addEventListener("mouseenter", () => highlight(id));
    group.addEventListener("mouseleave", () => highlight(selectedId));
    nodeLayer.append(group);
    nodeElements.set(id, group);
  }

  function highlight(focusId) {
    svg.classList.toggle("has-focus", Boolean(focusId));
    const related = new Set(focusId ? [focusId] : []);
    for (const edge of edgeElements) {
      const active = focusId && (edge.dataset.from === focusId || edge.dataset.to === focusId);
      edge.classList.toggle("is-related", Boolean(active));
      if (active) {
        related.add(edge.dataset.from);
        related.add(edge.dataset.to);
      }
    }
    for (const [id, element] of nodeElements) {
      element.classList.toggle("is-related", related.has(id));
      element.classList.toggle("is-selected", id === selectedId);
    }
  }

  target.replaceChildren(svg);
  highlight(selectedId);
  return {
    svg,
    width,
    height,
    setSelected(id, reveal = false) {
      selectedId = id;
      highlight(id);
      if (reveal) {
        nodeElements.get(id)?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      }
    }
  };
}

export function graphCard({ title, eyebrow, legend = "" }) {
  const section = document.createElement("section");
  section.className = "view-card graph-card";
  section.innerHTML = `
    <header class="view-card-header graph-header">
      <div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(title)}</h2></div>
      <div class="diagram-tools" aria-label="Graph controls">
        <button class="tool-button" data-zoom="out" type="button" aria-label="Zoom out">−</button>
        <button class="tool-button" data-zoom="fit" type="button" aria-label="Fit to width">Fit</button>
        <button class="tool-button" data-zoom="reset" type="button" aria-label="Actual size" data-zoom-label>100%</button>
        <button class="tool-button" data-zoom="in" type="button" aria-label="Zoom in">+</button>
      </div>
    </header>
    ${legend ? `<div class="graph-legend">${legend}</div>` : ""}
    <div class="graph-viewport" tabindex="-1"><p class="rendering">Laying out graph</p></div>`;
  return section;
}

export function enablePanZoom(section, state) {
  const viewport = section.querySelector(".graph-viewport");
  const svg = viewport.querySelector("svg");
  if (!svg) {
    return;
  }
  const naturalWidth = Number(svg.getAttribute("width"));
  const naturalHeight = Number(svg.getAttribute("height"));
  const label = section.querySelector("[data-zoom-label]");
  const fitScale = () => Math.min(1, (viewport.clientWidth - 24) / naturalWidth);
  const apply = (scale) => {
    state.scale = Math.min(2.5, Math.max(0.25, scale));
    svg.style.width = `${naturalWidth * state.scale}px`;
    svg.style.height = `${naturalHeight * state.scale}px`;
    label.textContent = `${Math.round(state.scale * 100)}%`;
  };
  apply(state.scale ?? Math.max(0.85, fitScale()));
  section.querySelector(".diagram-tools").addEventListener("click", (event) => {
    const action = event.target.closest("button")?.dataset.zoom;
    if (action === "in") apply(state.scale + 0.15);
    else if (action === "out") apply(state.scale - 0.15);
    else if (action === "reset") apply(1);
    else if (action === "fit") apply(fitScale());
  });
  viewport.addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      apply(state.scale * (event.deltaY < 0 ? 1.08 : 0.92));
    }
  }, { passive: false });
  let drag = null;
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".graph-node")) {
      return;
    }
    drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("is-panning");
  });
  viewport.addEventListener("pointermove", (event) => {
    if (drag) {
      viewport.scrollLeft = drag.left - (event.clientX - drag.x);
      viewport.scrollTop = drag.top - (event.clientY - drag.y);
    }
  });
  const end = () => {
    drag = null;
    viewport.classList.remove("is-panning");
  };
  viewport.addEventListener("pointerup", end);
  viewport.addEventListener("pointercancel", end);
}
