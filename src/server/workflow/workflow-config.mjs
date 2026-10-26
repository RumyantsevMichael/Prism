import { readFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.join(".prism", "workflow.md");
const CONFIG_MAX_BYTES = 256 * 1024;

// Labels match on the text before any parenthesized note, so "Plans (scratch)" and "Plans (coordination scratch)" both name the plans path.
const PATH_KEYS = new Map([
  ["requirements", "requirements"],
  ["adrs", "adrs"],
  ["plans", "plans"],
  ["feature files", "features"],
  ["roadmap", "roadmap"],
  ["glossary", "glossary"],
  ["user guide", "userGuide"],
  ["product strategy", "productStrategy"]
]);

export const DEFAULT_PATHS = Object.freeze({
  requirements: "docs/requirements",
  adrs: "docs/ADRs",
  plans: "docs/plans",
  features: "docs/Features",
  roadmap: "docs/roadmap.md",
  glossary: "docs/Glossary.md",
  userGuide: "docs/user-guide",
  productStrategy: null
});

function sections(markdown) {
  const result = new Map();
  let current = null;
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = line.trim().match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[1][0] : fence === fenceMatch[1][0] ? null : fence;
      continue;
    }
    if (fence) {
      continue;
    }
    const heading = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) {
      current = heading[1].trim();
      if (!result.has(current)) {
        result.set(current, []);
      }
      continue;
    }
    if (/^#\s/.test(line)) {
      current = null;
      continue;
    }
    const entry = line.match(/^\s*-\s+([^:]+):\s*(.*?)\s*$/);
    if (current && entry) {
      result.get(current).push({ label: entry[1].trim(), value: entry[2].replace(/^(['"])(.*)\1$/, "$2").trim() });
    }
  }
  return result;
}

function normalizePath(value, label, diagnostics) {
  if (!value || /^n\/a$/i.test(value)) {
    return null;
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/\/$/, "");
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(value)) {
    diagnostics.push({ code: "path_absolute", label, message: `${label} must be relative to the project root.` });
    return null;
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    diagnostics.push({ code: "path_outside_project", label, message: `${label} leaves the project root.` });
    return null;
  }
  return normalized === "." ? "" : normalized;
}

export function parseWorkflowConfig(markdown) {
  const diagnostics = [];
  const parsed = sections(markdown ?? "");
  const paths = { ...DEFAULT_PATHS };
  const configured = new Set();
  if (!parsed.has("Paths")) {
    diagnostics.push({ code: "paths_missing", message: "The workflow config has no Paths section, so defaults apply." });
  }
  for (const { label, value } of parsed.get("Paths") ?? []) {
    const key = PATH_KEYS.get(label.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase());
    if (!key) {
      diagnostics.push({ code: "path_unknown", label, message: `${label} is not a known path key.` });
      continue;
    }
    if (configured.has(key)) {
      diagnostics.push({ code: "path_duplicate", label, message: `${label} is configured more than once; the first value applies.` });
      continue;
    }
    configured.add(key);
    paths[key] = normalizePath(value, label, diagnostics);
  }
  const values = Object.fromEntries([...parsed].map(([name, entries]) => [name, Object.fromEntries(entries.map((entry) => [entry.label, entry.value]))]));
  return { paths, configured: [...configured].sort(), sections: values, diagnostics };
}

export async function readWorkflowConfig(projectRoot) {
  let markdown = "";
  let exists = true;
  try {
    const bytes = await readFile(path.join(projectRoot, CONFIG_PATH));
    if (bytes.length > CONFIG_MAX_BYTES) {
      throw Object.assign(new Error("The workflow config exceeds 256 KiB."), { code: "config_too_large" });
    }
    markdown = bytes.toString("utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    exists = false;
  }
  const result = parseWorkflowConfig(markdown);
  if (!exists) {
    result.diagnostics.unshift({ code: "config_missing", message: "The project has no .prism/workflow.md, so defaults apply." });
  }
  return { exists, ...result };
}

// The roadmap record sits beside the configured roadmap projection and shares its base name.
export function roadmapPaths(config) {
  const projection = config.paths.roadmap;
  if (!projection) {
    return null;
  }
  const base = projection.endsWith(".md") ? projection.slice(0, -3) : projection;
  return { record: `${base}.json`, projection: projection.endsWith(".md") ? projection : `${base}.md` };
}

export function initiativeDirectory(config, initiative) {
  return config.paths.plans === null ? null : path.posix.join(config.paths.plans, initiative);
}
