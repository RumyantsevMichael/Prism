// Generated from src/server/workflow/components.mts by scripts/native-build/compile.mjs.
import { REPOSITORY_NAME } from "./repository-names.mjs";
const COMPONENT_NAME = REPOSITORY_NAME;
const ROOT_NAME = "root";
class ComponentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ComponentError";
    this.code = code;
    Object.assign(this, details);
  }
}
const label = (value) => value.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
const none = (value) => value === "" || /^n\/a$/i.test(value);
const list = (value) => none(value.trim()) ? [] : value.split(",").map((item) => item.trim());
function componentPath(value) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (trimmed === "" || trimmed.startsWith("/") || /[\\:]/.test(trimmed)) return null;
  return trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ? null : trimmed;
}
const inside = (file, folder) => file === folder || file.startsWith(`${folder}/`);
function repositoryOf(lines) {
  for (const line of lines) {
    const entry = /^\s*-\s+([^:]+):\s*(.*?)\s*$/.exec(line);
    if (!entry || label(entry[1]) !== "repository") continue;
    const value = unquote(entry[2]);
    if (none(value)) return { name: ROOT_NAME };
    return COMPONENT_NAME.test(value) ? { name: value } : { line };
  }
  return { name: ROOT_NAME };
}
const invalid = (entry, reason) => new ComponentError("component_invalid", `The ## Components declaration in .prism/workflow.md is invalid: ${JSON.stringify(entry)} ${reason}`, { entry });
function readComponents(config) {
  const lines = config?.lines ?? {};
  const repository = repositoryOf(lines.Workspace ?? []);
  if (repository.line !== void 0) throw invalid(repository.line, "names the repository with a name that is not lowercase letters, digits, hyphens, or underscores of at most 64 characters that start and end with a letter or digit.");
  const stack = Object.entries(config?.sections?.Stack ?? {}).find(([key]) => label(key) === "test command")?.[1];
  const root = { name: repository.name, identity: `${repository.name}/${repository.name}`, folder: "", testCommand: stack === void 0 || none(stack) ? null : stack, dependsOn: [] };
  const declared = [];
  const sharedPaths = [];
  let current = null;
  for (const line of lines.Components ?? []) {
    const top = /^-\s+(.*?)\s*$/.exec(line);
    const nested = top ? null : /^\s+-\s+(.*?)\s*$/.exec(line);
    if (!top && !nested) continue;
    const [, key = "", value = ""] = /^([^:]*):\s*(.*)$/.exec((top ?? nested)[1]) ?? [null, (top ?? nested)[1], ""];
    if (top) {
      current = null;
      if (label(key) === "shared paths") {
        for (const item of list(unquote(value))) {
          const shared = componentPath(item);
          if (shared === null) throw invalid(line, "lists a shared path that is not a project-relative path.");
          sharedPaths.push(shared);
        }
        current = { line, shared: true };
        continue;
      }
      const name = key.trim();
      if (!COMPONENT_NAME.test(name)) throw invalid(line, "names a component with a name that is not lowercase letters, digits, hyphens, or underscores of at most 64 characters that start and end with a letter or digit.");
      const folder = componentPath(unquote(value));
      if (folder === null) throw invalid(line, "names a folder that is not a project-relative path.");
      if (name === root.name) throw invalid(line, `declares the name of the root component ${root.name}.`);
      if (declared.some((component) => component.name === name)) throw invalid(line, `declares the component ${name} a second time.`);
      current = { name, identity: `${repository.name}/${name}`, folder, testCommand: null, dependsOn: [], line, commandSet: false };
      declared.push(current);
      continue;
    }
    if (current === null || current.shared) throw invalid(line, "is a nested item before any component.");
    const nestedLabel = label(key);
    if (nestedLabel === "test command") {
      const command = unquote(value);
      if (!current.commandSet && !none(command)) current.testCommand = command;
      current.commandSet = true;
    } else if (nestedLabel === "depends on") {
      for (const dependency of list(unquote(value))) {
        const parts = dependency.split("/");
        if (parts.length > 2 || !parts.every((part) => COMPONENT_NAME.test(part))) throw invalid(line, "names a dependency that is neither a component name nor <repository>/<component>.");
        current.dependsOn.push(dependency);
      }
    } else {
      throw invalid(line, "uses a label other than Test command or Depends on.");
    }
  }
  for (const [index, left] of declared.entries()) {
    for (const right of declared.slice(index + 1)) {
      if (inside(left.folder, right.folder) || inside(right.folder, left.folder)) {
        throw new ComponentError("component_overlap", `The components ${left.name} (${left.folder}) and ${right.name} (${right.folder}) declared in .prism/workflow.md overlap: each component needs a folder of its own, outside every other component's folder.`, { components: [{ name: left.name, folder: left.folder }, { name: right.name, folder: right.folder }] });
      }
    }
  }
  const names = new Map([[root.name, root], ...declared.map((component) => [component.name, component])]);
  const local = (dependency) => {
    const parts = dependency.split("/");
    return parts.length === 1 ? parts[0] : parts[0] === repository.name ? parts[1] : null;
  };
  for (const component of declared) {
    for (const dependency of component.dependsOn) {
      const name = local(dependency);
      if (name !== null && !names.has(name)) throw new ComponentError("component_dependency_unknown", `The component ${component.name} declared in .prism/workflow.md depends on ${dependency}, which is neither a declared component nor the root component ${root.name}.`, { component: component.name, dependency });
    }
  }
  const edges = (component) => [...new Set(component.dependsOn.map(local).filter((name) => name !== null))].map((name) => names.get(name));
  for (const start of declared) {
    const previous = /* @__PURE__ */ new Map();
    const queue = [start];
    let found = false;
    while (queue.length && !found) {
      const node = queue.shift();
      for (const next of edges(node)) {
        if (next === start) {
          previous.set(start, node);
          found = true;
          break;
        }
        if (!previous.has(next)) {
          previous.set(next, node);
          queue.push(next);
        }
      }
    }
    if (!found) continue;
    const back = [start];
    for (let node = previous.get(start); node !== start; node = previous.get(node)) back.push(node);
    const cycle = [start, ...back.slice(1).reverse(), start].map((component) => component.name);
    throw new ComponentError("component_cycle", `The components declared in .prism/workflow.md depend on each other in a cycle: ${cycle.join(" -> ")}.`, { cycle });
  }
  const view = ({ name, identity, folder, testCommand, dependsOn }) => ({ name, identity, folder, testCommand, dependsOn: [...dependsOn] });
  const rootComponent = view(root);
  const components = declared.map(view);
  return { repository: repository.name, root: rootComponent, declared: components, components: [rootComponent, ...components], sharedPaths };
}
function listsComponents(config) {
  return (config?.lines?.Components ?? []).some((line) => {
    const top = /^-\s+(.*?)\s*$/.exec(line);
    return top !== null && label(/^([^:]*)/.exec(top[1])[1]) !== "shared paths";
  });
}
function listComponents(config) {
  let declaration;
  try {
    declaration = readComponents(config);
  } catch (error) {
    if (!(error instanceof ComponentError)) throw error;
    return { repository: repositoryOf(config?.lines?.Workspace ?? []).name ?? null, declared: [], problem: { code: error.code, message: error.message } };
  }
  const identity = (dependency) => dependency.includes("/") ? dependency : `${declaration.repository}/${dependency}`;
  return {
    repository: declaration.repository,
    declared: declaration.components.map((component) => ({ component: component.identity, folder: component.folder, testCommand: component.testCommand, dependsOn: component.dependsOn.map(identity) }))
  };
}
function componentOf(declaration, file) {
  const normalized = file.replace(/\/$/, "");
  return declaration.declared.find((component) => inside(normalized, component.folder)) ?? declaration.root;
}
function underSharedPath(declaration, file) {
  const normalized = file.replace(/\/$/, "");
  return declaration.sharedPaths.some((shared) => inside(normalized, shared));
}
function findComponent(declaration, given) {
  const parts = given.split("/");
  if (parts.length > 2) return null;
  if (parts.length === 2 && parts[0] !== declaration.repository) return null;
  const name = parts.at(-1);
  return declaration.components.find((component) => component.name === name) ?? null;
}
function localDependencies(declaration, component) {
  const named = component.dependsOn.map((dependency) => {
    const parts = dependency.split("/");
    return parts.length === 1 ? parts[0] : parts[0] === declaration.repository ? parts[1] : null;
  }).filter((name) => name !== null);
  return declaration.components.filter((other) => named.includes(other.name));
}
function dependencyOrder(declaration) {
  const placed = /* @__PURE__ */ new Set();
  const order = [];
  while (order.length < declaration.components.length) {
    const next = declaration.components.find((component) => !placed.has(component.identity) && localDependencies(declaration, component).every((dependency) => placed.has(dependency.identity)));
    if (!next) break;
    placed.add(next.identity);
    order.push(next);
  }
  return order;
}
function dependentsOf(declaration, components) {
  const reached = new Set(components.map((component) => component.identity));
  const dependents = /* @__PURE__ */ new Set();
  const order = dependencyOrder(declaration);
  for (const component of order) {
    if (localDependencies(declaration, component).some((dependency) => reached.has(dependency.identity) || dependents.has(dependency.identity))) dependents.add(component.identity);
  }
  return order.filter((component) => dependents.has(component.identity));
}
export {
  COMPONENT_NAME,
  ComponentError,
  componentOf,
  componentPath,
  dependencyOrder,
  dependentsOf,
  findComponent,
  listComponents,
  listsComponents,
  readComponents,
  underSharedPath
};
