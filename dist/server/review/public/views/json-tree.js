// Generated from src/server/review/public/views/json-tree.ts by scripts/native-build/compile.mjs.
import { EVIDENCE_ID, escapeHtml, pathName } from "./util.js";
function text(value) {
  if (value === null) return "null";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
function summary(value) {
  return Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`;
}
function openable(value, ctx) {
  if (!ctx || typeof value !== "string") return null;
  if (ctx.hasArtifact?.(value)) return { path: value, anchor: "" };
  const at = value.indexOf("#");
  if (at > 0 && ctx.hasArtifact?.(value.slice(0, at))) return { path: value.slice(0, at), anchor: value.slice(at + 1) };
  return null;
}
function link(value, ctx) {
  if (!ctx || typeof value !== "string") return "";
  if (EVIDENCE_ID.test(value)) return `<prism-chip slot="end" interactive tone="accent" data-evidence="${value}" data-label="Evidence" tip="Open evidence">Evidence</prism-chip>`;
  const target = openable(value, ctx);
  if (!target) return "";
  const { label, code } = pathName(target.path, ctx);
  const anchor = target.anchor ? ` data-doc-anchor="${escapeHtml(target.anchor)}"` : "";
  return `<prism-chip slot="end" interactive tone="accent" data-artifact="${escapeHtml(target.path)}"${anchor}${code ? " data-code-subject" : ""} tip="Open ${escapeHtml(label)}">Open</prism-chip>`;
}
function leafText(value, ctx) {
  const target = openable(value, ctx);
  if (target) {
    const { label, code } = pathName(target.path, ctx);
    if (!code) return target.anchor ? `${label} \u203A ${target.anchor}` : label;
  }
  return text(value);
}
function node(key, value, pointer, depth, openDepth, ctx) {
  const name = key === null ? "" : `${key}: `;
  const attributes = `value="${escapeHtml(pointer || "/")}"`;
  if (value === null || typeof value !== "object") {
    return `<prism-tree-item ${attributes} label="${escapeHtml(name + leafText(value, ctx))}"${depth === 0 ? " selected" : ""}>${link(value, ctx)}</prism-tree-item>`;
  }
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  if (entries.length === 0) {
    return `<prism-tree-item ${attributes} label="${escapeHtml(name + (Array.isArray(value) ? "[]" : "{}"))}"></prism-tree-item>`;
  }
  const children = entries.map(([childKey, child]) => node(childKey, child, `${pointer}/${childKey.replaceAll("~", "~0").replaceAll("/", "~1")}`, depth + 1, openDepth, ctx)).join("");
  return `<prism-tree-item ${attributes} label="${escapeHtml(name + summary(value))}"${depth < openDepth ? " expanded" : ""}>${children}</prism-tree-item>`;
}
function jsonTreeHtml(value, { openDepth = 2, ctx = null, label = "JSON document" } = {}) {
  return `<prism-tree class="json-view-tree" label="${escapeHtml(label)}">${node(null, value, "", 0, openDepth, ctx)}</prism-tree>`;
}
export {
  jsonTreeHtml
};
