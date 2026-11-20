// Generated from src/server/workflow/workflow-config.mts by scripts/native-build/compile.mjs.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isRemoteStore } from "./remote-url.mjs";
const CONFIG_PATH = path.join(".prism", "workflow.md");
const CONFIG_MAX_BYTES = 256 * 1024;
const PATH_KEYS = /* @__PURE__ */ new Map([
  ["requirements", "requirements"],
  ["adrs", "adrs"],
  ["plans", "plans"],
  ["feature files", "features"],
  ["roadmap", "roadmap"],
  ["glossary", "glossary"],
  ["user guide", "userGuide"],
  ["product strategy", "productStrategy"]
]);
const DEFAULT_PATHS = Object.freeze({
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
  const result = /* @__PURE__ */ new Map();
  const lines = /* @__PURE__ */ new Map();
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
        lines.set(current, []);
      }
      continue;
    }
    if (/^#\s/.test(line)) {
      current = null;
      continue;
    }
    if (current) {
      lines.get(current).push(line);
    }
    const entry = line.match(/^\s*-\s+([^:]+):\s*(.*?)\s*$/);
    if (current && entry) {
      result.get(current).push({ label: entry[1].trim(), value: entry[2].replace(/^(['"])(.*)\1$/, "$2").trim() });
    }
  }
  return { entries: result, lines };
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
function workspaceValue(parsed, key) {
  const entry = (parsed.get("Workspace") ?? []).find(({ label }) => label.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase() === key);
  return !entry?.value || /^n\/a$/i.test(entry.value) ? null : entry.value;
}
function parseWorkflowConfig(markdown) {
  const diagnostics = [];
  const { entries: parsed, lines } = sections(markdown ?? "");
  const paths = { ...DEFAULT_PATHS };
  const configured = /* @__PURE__ */ new Set();
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
  const store = workspaceValue(parsed, "store");
  const sync = workspaceValue(parsed, "store sync") ?? "";
  const repository = store === null ? null : workspaceValue(parsed, "repository");
  const raw = Object.fromEntries(["Components", "Workspace"].filter((name) => lines.has(name)).map((name) => [name, lines.get(name)]));
  return { paths, configured: [...configured].sort(), sections: values, lines: raw, workspace: { store, repository, sync: isRemoteStore(store) ? !/^off$/i.test(sync) : /^on$/i.test(sync) }, diagnostics };
}
async function readWorkflowConfig(projectRoot) {
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
function runStatisticsCollection(config) {
  if (!config || typeof config !== "object" || !config.sections || typeof config.sections !== "object") {
    return "unknown";
  }
  const sectionName = Object.keys(config.sections).find((name) => name.toLowerCase() === "run statistics");
  const entries = sectionName ? config.sections[sectionName] ?? {} : {};
  const label = Object.keys(entries).find((name) => name.trim().toLowerCase() === "collection");
  return label !== void 0 && String(entries[label]).trim().toLowerCase() === "off" ? "off" : "on";
}
function roadmapPaths(config) {
  const projection = config.paths.roadmap;
  if (!projection) {
    return null;
  }
  const base = projection.endsWith(".md") ? projection.slice(0, -3) : projection;
  return { record: `${base}.json`, projection: projection.endsWith(".md") ? projection : `${base}.md` };
}
function initiativeDirectory(config, initiative) {
  return config.paths.plans === null ? null : path.posix.join(config.paths.plans, initiative);
}
const ARTIFACT_KIND_SHAPES = Object.freeze([["requirements", true], ["adrs", true], ["plans", true], ["glossary", false], ["roadmap", false]]);
function artifactKinds(config) {
  const kinds = ARTIFACT_KIND_SHAPES.filter(([kind]) => typeof config?.paths?.[kind] === "string").map(([kind, folder]) => ({ kind, path: config.paths[kind], folder })).sort((left, right) => right.path.length - left.path.length);
  const excluded = [config?.paths?.features, config?.paths?.userGuide].filter((value) => typeof value === "string");
  return { kinds, excluded };
}
export {
  DEFAULT_PATHS,
  artifactKinds,
  initiativeDirectory,
  parseWorkflowConfig,
  readWorkflowConfig,
  roadmapPaths,
  runStatisticsCollection
};
