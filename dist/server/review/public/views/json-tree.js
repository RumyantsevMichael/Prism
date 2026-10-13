import { EVIDENCE_ID, escapeHtml } from "./util.js";

function primitive(value, ctx) {
  if (value === null) {
    return '<span class="json-null">null</span>';
  }
  if (typeof value === "string") {
    if (ctx && EVIDENCE_ID.test(value)) {
      return `<button type="button" class="json-link" data-evidence="${value}" data-label="Evidence" title="Open evidence">"${escapeHtml(value)}"</button>`;
    }
    if (ctx?.hasArtifact(value)) {
      return `<button type="button" class="json-link" data-artifact="${escapeHtml(value)}" title="Open artifact">"${escapeHtml(value)}"</button>`;
    }
    return `<span class="json-string">"${escapeHtml(value)}"</span>`;
  }
  return `<span class="json-${typeof value}">${escapeHtml(String(value))}</span>`;
}

function summary(value) {
  return Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`;
}

function node(key, value, depth, openDepth, ctx) {
  const label = key === null ? "" : `<span class="json-key">${escapeHtml(key)}</span>: `;
  if (value === null || typeof value !== "object") {
    return `<li>${label}${primitive(value, ctx)}</li>`;
  }
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  if (entries.length === 0) {
    return `<li>${label}<span class="json-empty">${Array.isArray(value) ? "[]" : "{}"}</span></li>`;
  }
  const children = entries.map(([childKey, child]) => node(childKey, child, depth + 1, openDepth, ctx)).join("");
  return `<li><details${depth < openDepth ? " open" : ""}><summary>${label}<span class="json-summary">${summary(value)}</span></summary><ul>${children}</ul></details></li>`;
}

export function jsonTreeHtml(value, { openDepth = 2, ctx = null } = {}) {
  return `<ul class="json-tree">${node(null, value, 0, openDepth, ctx)}</ul>`;
}
