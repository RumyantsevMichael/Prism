import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

// A ## Components block proposed from the workspace manifests at a project root: the folders that their workspace patterns match,
// each named after its own manifest, with a test command from its package.json test script and dependencies on the other proposed folders.
// Prism only reads manifests here and never writes the proposal to any file.

const MANIFEST_MAX_BYTES = 1024 * 1024;
const MEMBER_MANIFESTS = ["package.json", "Cargo.toml", "go.mod", "Package.swift"];
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "go.work.sum"];
// The lockfiles that each workspace tool keeps at the root; for JavaScript only the package manager's own lockfiles count, so a stray one stays in the root component.
const TOOL_LOCKFILES = { bun: ["bun.lock", "bun.lockb"], pnpm: ["pnpm-lock.yaml"], yarn: ["yarn.lock"], npm: ["package-lock.json"], cargo: ["Cargo.lock"], go: ["go.work.sum"] };
const PACKAGE_DEPENDENCIES = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const CARGO_DEPENDENCIES = ["dependencies", "dev-dependencies"];
const NAME_LIMIT = 64;

class Unreadable extends Error {}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const byCodePoint = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

async function isFile(file) {
  try { return (await lstat(file)).isFile(); } catch { return false; }
}

async function isFolder(folder) {
  try { return (await lstat(folder)).isDirectory(); } catch { return false; }
}

// A manifest's text, null when it does not exist, or an Unreadable error with the reason.
async function manifestText(root, relative) {
  const file = path.join(root, relative);
  let stats;
  try { stats = await lstat(file); } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw new Unreadable(`could not be read: ${error.message}`);
  }
  if (!stats.isFile()) return null;
  if (stats.size > MANIFEST_MAX_BYTES) throw new Unreadable("is larger than 1 MiB.");
  try { return (await readFile(file)).toString("utf8"); } catch (error) { throw new Unreadable(`could not be read: ${error.message}`); }
}

function parseJson(text) {
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new Unreadable(`is not valid JSON: ${error.message}`); }
  if (!isObject(value)) throw new Unreadable("is not a JSON object.");
  return value;
}

/**
 * Parse the TOML that Cargo manifests use: tables, arrays of tables, dotted and quoted keys, strings of every kind, arrays, inline tables,
 * and other scalars kept as their text. Anything else throws Unreadable, so a manifest is never guessed at.
 */
export function parseToml(text) {
  const root = {};
  let table = root;
  let index = 0;
  const line = () => text.slice(0, index).split("\n").length;
  const fail = (reason) => { throw new Unreadable(`is not TOML that Prism can read: ${reason} on line ${line()}.`); };
  const blank = () => { while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1; };
  const comment = () => { if (text[index] === "#") while (index < text.length && text[index] !== "\n") index += 1; };
  const space = () => {
    for (;;) {
      blank();
      comment();
      if (text[index] === "\r" && text[index + 1] === "\n") index += 2;
      else if (text[index] === "\n") index += 1;
      else return;
    }
  };
  const escapes = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", "\"": "\"", "\\": "\\" };
  const basic = (multiline) => {
    let value = "";
    for (;;) {
      if (index >= text.length) fail("an unterminated string");
      if (!multiline && text[index] === "\"") { index += 1; return value; }
      if (multiline && text.startsWith("\"\"\"", index)) {
        // Up to two quotes before the closing three belong to the string.
        let quotes = 3;
        while (quotes < 5 && text[index + quotes] === "\"") quotes += 1;
        index += quotes;
        return value + "\"".repeat(quotes - 3);
      }
      const character = text[index];
      if (!multiline && character === "\n") fail("a line break inside a string");
      if (character !== "\\") { value += character; index += 1; continue; }
      const next = text[index + 1];
      if (multiline && /[ \t\r\n]/.test(next ?? "")) {
        index += 1;
        while (/[ \t\r\n]/.test(text[index] ?? "")) index += 1;
        continue;
      }
      if (next === "u" || next === "U") {
        const length = next === "u" ? 4 : 8;
        const hex = text.slice(index + 2, index + 2 + length);
        if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex)) fail("an invalid unicode escape");
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        index += 2 + length;
        continue;
      }
      if (!Object.hasOwn(escapes, next)) fail("an invalid escape");
      value += escapes[next];
      index += 2;
    }
  };
  const literal = (multiline) => {
    const end = multiline ? "'''" : "'";
    const close = text.indexOf(end, index);
    if (close === -1) fail("an unterminated string");
    let value = text.slice(index, close);
    if (!multiline && value.includes("\n")) fail("a line break inside a string");
    index = close + end.length;
    while (multiline && text[index] === "'") { value += "'"; index += 1; }
    return value;
  };
  const string = () => {
    if (text.startsWith("\"\"\"", index)) { index += 3; if (text[index] === "\n") index += 1; else if (text.startsWith("\r\n", index)) index += 2; return basic(true); }
    if (text.startsWith("'''", index)) { index += 3; if (text[index] === "\n") index += 1; else if (text.startsWith("\r\n", index)) index += 2; return literal(true); }
    if (text[index] === "\"") { index += 1; return basic(false); }
    index += 1;
    return literal(false);
  };
  const key = () => {
    const parts = [];
    for (;;) {
      blank();
      if (text[index] === "\"" || text[index] === "'") parts.push(string());
      else {
        const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(index, index + 4096));
        if (!bare) fail("a key that is missing or not bare or quoted");
        parts.push(bare[0]);
        index += bare[0].length;
      }
      blank();
      if (text[index] !== ".") return parts;
      index += 1;
    }
  };
  const value = () => {
    const character = text[index];
    if (character === "\"" || character === "'") return string();
    if (character === "[") {
      index += 1;
      const items = [];
      for (;;) {
        space();
        if (text[index] === "]") { index += 1; return items; }
        items.push(value());
        space();
        if (text[index] === ",") { index += 1; continue; }
        if (text[index] === "]") { index += 1; return items; }
        fail("an array item that is not followed by a comma or ]");
      }
    }
    if (character === "{") {
      index += 1;
      const inline = {};
      for (;;) {
        space();
        if (text[index] === "}") { index += 1; return inline; }
        const parts = key();
        if (text[index] !== "=") fail("an inline table key without =");
        index += 1;
        blank();
        assign(inline, parts, value());
        space();
        if (text[index] === ",") { index += 1; continue; }
        if (text[index] === "}") { index += 1; return inline; }
        fail("an inline table entry that is not followed by a comma or }");
      }
    }
    // Numbers, booleans, and dates are kept as their text, which no reader here needs.
    const scalar = /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?|[A-Za-z0-9_+.:-]+)/.exec(text.slice(index, index + 4096));
    if (!scalar) fail("a value that is not a string, array, inline table, or scalar");
    index += scalar[0].length;
    return scalar[0] === "true" ? true : scalar[0] === "false" ? false : scalar[0];
  };
  function descend(target, parts) {
    let current = target;
    for (const part of parts) {
      if (!Object.hasOwn(current, part)) current[part] = {};
      const next = current[part];
      current = Array.isArray(next) ? next.at(-1) : next;
      if (!isObject(current)) fail(`a key ${parts.join(".")} that is already a value`);
    }
    return current;
  }
  function assign(target, parts, item) {
    const parent = descend(target, parts.slice(0, -1));
    parent[parts.at(-1)] = item;
  }
  for (;;) {
    space();
    if (index >= text.length) return root;
    if (text[index] === "[") {
      const array = text[index + 1] === "[";
      index += array ? 2 : 1;
      const parts = key();
      if (!text.startsWith(array ? "]]" : "]", index)) fail("a table header without its closing bracket");
      index += array ? 2 : 1;
      if (array) {
        const parent = descend(root, parts.slice(0, -1));
        const last = parts.at(-1);
        if (!Object.hasOwn(parent, last)) parent[last] = [];
        if (!Array.isArray(parent[last])) fail(`an array of tables ${parts.join(".")} that is already a table`);
        table = {};
        parent[last].push(table);
      } else {
        table = descend(root, parts);
      }
    } else {
      const parts = key();
      if (text[index] !== "=") fail("a key without =");
      index += 1;
      blank();
      assign(table, parts, value());
    }
    blank();
    comment();
    if (index < text.length && text[index] !== "\n" && !text.startsWith("\r\n", index)) fail("text after a value");
  }
}

const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

// A plain or quoted YAML scalar, or undefined when it uses YAML that this reader does not read.
function yamlScalar(raw) {
  const value = raw.trim();
  const quoted = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)')\s*(?:#.*)?$/.exec(value);
  if (quoted) return quoted[1] !== undefined ? quoted[1].replace(/\\(.)/g, "$1") : quoted[2].replaceAll("''", "'");
  if (/^[[\]{}&*!|>%@`"']/.test(value) && !value.startsWith("!")) return undefined;
  const plain = value.replace(/\s+#.*$/, "").trim();
  return plain === "" || /^["']/.test(plain) ? undefined : plain;
}

/** The packages list of a pnpm-workspace.yaml: a block list or a flow list of plain or quoted strings, or an Unreadable error. */
export function pnpmPatterns(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((entry) => /^packages\s*:/.test(entry));
  if (start === -1) return [];
  const unreadable = (reason) => new Unreadable(`is not YAML that Prism can read: ${reason} on line ${start + 1}.`);
  const rest = lines[start].replace(/^packages\s*:/, "").replace(/(^|\s)#.*$/, "").trim();
  if (rest !== "") {
    const flow = /^\[(.*)\]$/.exec(rest);
    if (!flow) throw unreadable("packages is neither a block list nor a flow list");
    if (flow[1].trim() === "") return [];
    return flow[1].split(",").map((item) => {
      const scalar = yamlScalar(item);
      if (scalar === undefined) throw unreadable("a packages item that is not a plain or quoted string");
      return scalar;
    });
  }
  const patterns = [];
  for (const entry of lines.slice(start + 1)) {
    if (entry.trim() === "" || /^\s*#/.test(entry)) continue;
    const item = /^(\s*)-\s+(.*)$/.exec(entry);
    if (!item) {
      if (!/^\s/.test(entry)) break;
      throw unreadable("a packages entry that is not a list item");
    }
    const scalar = yamlScalar(item[2]);
    if (scalar === undefined) throw unreadable("a packages item that is not a plain or quoted string");
    patterns.push(scalar);
  }
  return patterns;
}

// The text of a Go file without its // comments, outside quoted paths.
const goLines = (text) => text.split(/\r?\n/).map((entry) => entry.replace(/\/\/.*$/, "").trim()).filter(Boolean);
const goPath = (value) => value.replace(/^"(.*)"$/, "$1").replace(/^`(.*)`$/, "$1");

/** The arguments of each `directive` line or block of a go.work or go.mod file, as lists of words. */
function goDirectives(text, directive) {
  const found = [];
  let block = false;
  for (const entry of goLines(text)) {
    if (block) {
      if (entry === ")") { block = false; continue; }
      found.push(entry.split(/\s+/).map(goPath));
      continue;
    }
    const words = entry.split(/\s+/);
    if (words[0] !== directive) continue;
    if (words[1] === "(") { block = true; continue; }
    if (words[1]?.startsWith("(")) throw new Unreadable(`has a ${directive} block that Prism cannot read.`);
    found.push(words.slice(1).map(goPath));
  }
  return found;
}

// A workspace pattern as a project-relative glob without ./, a trailing /, or . segments, or null when it leaves the project or names its root.
function normalizePattern(pattern) {
  const normalized = path.posix.normalize(pattern.trim().replaceAll("\\", "/")).replace(/\/+$/, "");
  if (normalized === "" || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  return normalized;
}

const excluded = (name) => name === "node_modules" || name.startsWith(".");
const segmentPattern = (segment) => new RegExp(`^${segment.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);

async function childFolders(root, relative) {
  try {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !excluded(entry.name)).map((entry) => entry.name).sort(byCodePoint);
  } catch {
    return [];
  }
}

/** The project-relative folders that a pattern matches, where * matches within one folder name and ** any number of folders, skipping node_modules and folders starting with a dot. */
async function matchPattern(root, pattern) {
  const segments = pattern.split("/");
  const matched = new Set();
  const seen = new Set();
  const visit = async (relative, position) => {
    const key = `${relative}\0${position}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (position === segments.length) {
      if (relative !== "") matched.add(relative);
      return;
    }
    const segment = segments[position];
    const join = (name) => (relative === "" ? name : `${relative}/${name}`);
    if (segment === "**") {
      await visit(relative, position + 1);
      for (const name of await childFolders(root, relative)) await visit(join(name), position);
      return;
    }
    if (segment.includes("*")) {
      const test = segmentPattern(segment);
      for (const name of await childFolders(root, relative)) if (test.test(name)) await visit(join(name), position + 1);
      return;
    }
    if (!excluded(segment) && await isFolder(path.join(root, join(segment)))) await visit(join(segment), position + 1);
  };
  await visit("", 0);
  return matched;
}

// The workspace patterns that the root manifests give, as { include, exclude, tools }, where tools names the workspace tools whose manifests give them,
// adding each root manifest Prism cannot read to skipped.
async function workspacePatterns(root, skipped) {
  const include = [];
  const exclude = [];
  const tools = new Set();
  const read = async (relative, parse) => {
    try {
      const text = await manifestText(root, relative);
      if (text !== null) parse(text);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      skipped.push({ path: relative, reason: `${relative} ${error.message}` });
    }
  };
  const add = (tool, patterns) => {
    tools.add(tool);
    for (const pattern of patterns) (pattern.startsWith("!") ? exclude : include).push(pattern.replace(/^!/, ""));
  };
  await read("package.json", (text) => {
    const workspaces = parseJson(text).workspaces;
    if (workspaces === undefined) return;
    const patterns = isObject(workspaces) ? workspaces.packages : workspaces;
    if (!strings(patterns)) throw new Unreadable("has workspaces that are neither a list of strings nor an object whose packages is one.");
    add("javascript", patterns);
  });
  await read("pnpm-workspace.yaml", (text) => {
    if (/^packages\s*:/m.test(text)) add("javascript", pnpmPatterns(text));
  });
  await read("Cargo.toml", (text) => {
    const workspace = parseToml(text).workspace;
    if (!isObject(workspace)) return;
    for (const field of ["members", "exclude"]) if (workspace[field] !== undefined && !strings(workspace[field])) throw new Unreadable(`has a [workspace] ${field} that is not a list of strings.`);
    if (workspace.members === undefined && workspace.exclude === undefined) return;
    add("cargo", workspace.members ?? []);
    exclude.push(...(workspace.exclude ?? []));
  });
  await read("go.work", (text) => {
    const uses = goDirectives(text, "use");
    if (uses.length) add("go", uses.map((words) => words[0]).filter((word) => word !== undefined));
  });
  return tools.size ? { include, exclude, tools } : null;
}

// What one member folder's manifests give: { packageName, cargoName, module, testScript, packageDependencies, cargoPaths, requires }, or { unreadable: true }.
async function readMember(root, folder, skipped) {
  const member = { packageName: null, cargoName: null, module: null, testScript: false, packageDependencies: [], cargoPaths: [], requires: [] };
  let unreadable = false;
  const read = async (file, parse) => {
    const relative = `${folder}/${file}`;
    try {
      const text = await manifestText(root, relative);
      if (text !== null) parse(text);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      skipped.push({ path: relative, reason: `${relative} ${error.message}` });
      unreadable = true;
    }
  };
  await read("package.json", (text) => {
    const manifest = parseJson(text);
    if (typeof manifest.name === "string") member.packageName = manifest.name;
    member.testScript = isObject(manifest.scripts) && Object.hasOwn(manifest.scripts, "test");
    for (const field of PACKAGE_DEPENDENCIES) if (isObject(manifest[field])) member.packageDependencies.push(...Object.keys(manifest[field]));
  });
  await read("Cargo.toml", (text) => {
    const manifest = parseToml(text);
    if (isObject(manifest.package) && typeof manifest.package.name === "string") member.cargoName = manifest.package.name;
    for (const field of CARGO_DEPENDENCIES) {
      if (!isObject(manifest[field])) continue;
      for (const dependency of Object.values(manifest[field])) {
        if (isObject(dependency) && typeof dependency.path === "string") member.cargoPaths.push(path.posix.normalize(path.posix.join(folder, dependency.path.replaceAll("\\", "/"))).replace(/\/+$/, ""));
      }
    }
  });
  await read("go.mod", (text) => {
    const modules = goDirectives(text, "module");
    if (modules.length && modules[0][0]) member.module = modules[0][0];
    member.requires = goDirectives(text, "require").map((words) => words[0]).filter(Boolean);
  });
  return unreadable ? { unreadable: true } : member;
}

/** A manifest name made into a component name: lowercased, each run of other characters than a-z, 0-9, _, and - replaced by -, trimmed of - and _, and cut to 64 characters. */
export function componentName(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, NAME_LIMIT).replace(/[-_]+$/, "");
}

function packageManager(lockfiles, rootFiles) {
  if (lockfiles.includes("bun.lock") || lockfiles.includes("bun.lockb")) return "bun";
  if (lockfiles.includes("pnpm-lock.yaml") || rootFiles.pnpmWorkspace) return "pnpm";
  if (lockfiles.includes("yarn.lock")) return "yarn";
  return "npm";
}

function blockMarkdown(components, sharedPaths) {
  const lines = ["## Components"];
  for (const component of components) {
    lines.push(`- ${component.name}: ${component.folder}`);
    if (component.testCommand !== null) lines.push(`  - Test command: ${component.testCommand}`);
    if (component.dependsOn.length) lines.push(`  - Depends on: ${component.dependsOn.join(", ")}`);
  }
  if (sharedPaths.length) lines.push(`- Shared paths: ${sharedPaths.join(", ")}`);
  return lines.map((entry) => `${entry}\n`).join("");
}

/**
 * Propose a ## Components block from the workspace manifests at a project root, or return null when no root manifest gives workspace patterns.
 * Returns { markdown, components, sharedPaths, skipped }, where components lists { name, folder, testCommand, dependsOn } in folder order,
 * rootName is the root component's name, which no proposed component takes, and every manifest Prism cannot read is listed in skipped as { path, reason }.
 */
export async function proposeComponents(root, { rootName }) {
  const skipped = [];
  const patterns = await workspacePatterns(root, skipped);
  if (patterns === null) return null;
  const folders = new Set();
  for (const pattern of patterns.include.map(normalizePattern).filter((item) => item !== null)) for (const folder of await matchPattern(root, pattern)) folders.add(folder);
  for (const pattern of patterns.exclude.map(normalizePattern).filter((item) => item !== null)) for (const folder of await matchPattern(root, pattern)) folders.delete(folder);
  const members = [];
  for (const folder of [...folders].sort(byCodePoint)) {
    const present = [];
    for (const file of MEMBER_MANIFESTS) if (await isFile(path.join(root, folder, file))) present.push(file);
    if (present.length) members.push({ folder, ...(await readMember(root, folder, skipped)) });
  }
  const lockfiles = [];
  for (const file of LOCKFILES) if (await isFile(path.join(root, file))) lockfiles.push(file);
  const manager = packageManager(lockfiles, { pnpmWorkspace: await isFile(path.join(root, "pnpm-workspace.yaml")) });
  const owned = new Set([...patterns.tools].flatMap((tool) => TOOL_LOCKFILES[tool === "javascript" ? manager : tool]));
  const sharedPaths = lockfiles.filter((file) => owned.has(file));

  const taken = new Set();
  const free = (name) => name !== "" && name !== rootName && !taken.has(name);
  for (const member of members) {
    const segment = componentName(member.folder.split("/").at(-1));
    const manifestName = member.unreadable ? null : member.packageName !== null ? member.packageName.split("/").at(-1) : member.cargoName ?? member.module?.split("/").at(-1) ?? null;
    let name = manifestName === null ? segment : componentName(manifestName);
    if (!free(name)) name = segment;
    for (let suffix = 2; !free(name); suffix += 1) name = `${segment.slice(0, NAME_LIMIT - `-${suffix}`.length)}-${suffix}`;
    taken.add(name);
    member.name = name;
  }

  // A package name or Go module that several folders share resolves to the first of them in folder order.
  const byPackage = new Map();
  const byModule = new Map();
  const byFolder = new Map(members.map((member) => [member.folder, member]));
  for (const member of members) {
    if (member.unreadable) continue;
    if (member.packageName !== null && !byPackage.has(member.packageName)) byPackage.set(member.packageName, member);
    if (member.module !== null && !byModule.has(member.module)) byModule.set(member.module, member);
  }
  const components = members.map((member) => {
    if (member.unreadable) return { name: member.name, folder: member.folder, testCommand: null, dependsOn: [] };
    const dependencies = new Set();
    for (const name of member.packageDependencies) if (byPackage.has(name)) dependencies.add(byPackage.get(name));
    for (const folder of member.cargoPaths) if (byFolder.has(folder)) dependencies.add(byFolder.get(folder));
    for (const module of member.requires) if (byModule.has(module)) dependencies.add(byModule.get(module));
    dependencies.delete(member);
    return {
      name: member.name,
      folder: member.folder,
      testCommand: member.testScript ? `${manager} run test` : null,
      dependsOn: [...dependencies].map((dependency) => dependency.name).sort(byCodePoint)
    };
  });
  return { markdown: blockMarkdown(components, sharedPaths), components, sharedPaths, skipped };
}
