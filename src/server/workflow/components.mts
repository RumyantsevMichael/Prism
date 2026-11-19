import { REPOSITORY_NAME } from "./repository-names.mjs";

// A repository's components: the folders it declares under ## Components in .prism/workflow.md, each with its own test command and dependencies,
// and the root component, named after the repository, which holds every other file.
// Each component is identified across the workspace as <repository>/<component>, so a dependency may name another repository's component.

export const COMPONENT_NAME = REPOSITORY_NAME;
const ROOT_NAME = "root";

export type Component = { name: string; identity: string; folder: string; testCommand: string | null; dependsOn: string[] };
type DeclaredComponent = Component & { line: string; commandSet: boolean; shared?: undefined };
export type ComponentDeclaration = { repository: string; root: Component; declared: Component[]; components: Component[]; sharedPaths: string[] };

export class ComponentError extends Error {
  declare code: string;
  [detail: string]: unknown;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ComponentError";
    this.code = code;
    Object.assign(this, details);
  }
}

// Labels match on the text before any parenthesized note and without case, as the labels of other sections do.
const label = (value: string) => value.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
const none = (value: string) => value === "" || /^n\/a$/i.test(value);
const list = (value: string) => none(value.trim()) ? [] : value.split(",").map((item: string) => item.trim());

/** A project-relative folder or file path read without a trailing slash, or null when it is empty, ".", absolute, or holds a backslash, a colon, or an empty, ".", or ".." segment. */
export function componentPath(value: string) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (trimmed === "" || trimmed.startsWith("/") || /[\\:]/.test(trimmed)) return null;
  return trimmed.split("/").some((segment: string) => segment === "" || segment === "." || segment === "..") ? null : trimmed;
}

const inside = (file: string, folder: string) => file === folder || file.startsWith(`${folder}/`);

// The Repository line under ## Workspace names the repository with or without a record store; the first one applies, as for other Workspace labels.
function repositoryOf(lines: string[]): { name?: string; line?: string } {
  for (const line of lines) {
    const entry = /^\s*-\s+([^:]+):\s*(.*?)\s*$/.exec(line);
    if (!entry || label(entry[1]) !== "repository") continue;
    const value = unquote(entry[2]);
    if (none(value)) return { name: ROOT_NAME };
    return COMPONENT_NAME.test(value) ? { name: value } : { line };
  }
  return { name: ROOT_NAME };
}

const invalid = (entry: string, reason: string) => new ComponentError("component_invalid", `The ## Components declaration in .prism/workflow.md is invalid: ${JSON.stringify(entry)} ${reason}`, { entry });

/**
 * Read a repository's components from its parsed workflow configuration: { repository, root, declared, components, sharedPaths }, where root is the root component,
 * declared lists the declared components in declaration order, and components lists the root component first and then the declared ones.
 * Each component is { name, identity, folder, testCommand, dependsOn }, where folder is "" for the root component and dependsOn lists dependencies as written.
 * An invalid declaration throws a ComponentError: component_invalid, component_overlap, component_dependency_unknown, or component_cycle, the first problem in that order and then in declaration order.
 */
export function readComponents(config: any): ComponentDeclaration {
  const lines = config?.lines ?? {};
  const repository = repositoryOf(lines.Workspace ?? []);
  if (repository.line !== undefined) throw invalid(repository.line, "names the repository with a name that is not lowercase letters, digits, hyphens, or underscores of at most 64 characters that start and end with a letter or digit.");
  const stack = Object.entries((config?.sections?.Stack ?? {}) as Record<string, string>).find(([key]) => label(key) === "test command")?.[1];
  const root: Component = { name: repository.name!, identity: `${repository.name}/${repository.name}`, folder: "", testCommand: stack === undefined || none(stack) ? null : stack, dependsOn: [] };
  const declared: DeclaredComponent[] = [];
  const sharedPaths: string[] = [];
  let current: DeclaredComponent | { line: string; shared: true } | null = null as DeclaredComponent | { line: string; shared: true } | null;
  for (const line of lines.Components ?? []) {
    const top = /^-\s+(.*?)\s*$/.exec(line);
    const nested = top ? null : /^\s+-\s+(.*?)\s*$/.exec(line);
    if (!top && !nested) continue;
    const [, key = "", value = ""] = /^([^:]*):\s*(.*)$/.exec((top ?? nested)![1]) ?? [null, (top ?? nested)![1], ""];
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
        if (parts.length > 2 || !parts.every((part: string) => COMPONENT_NAME.test(part))) throw invalid(line, "names a dependency that is neither a component name nor <repository>/<component>.");
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
  // A dependency of this repository is a bare name or one qualified with its own name; another repository's component is checked only for its form.
  const names = new Map<string, Component>([[root.name, root], ...declared.map((component): [string, Component] => [component.name, component])]);
  const local = (dependency: string) => {
    const parts = dependency.split("/");
    return parts.length === 1 ? parts[0] : parts[0] === repository.name ? parts[1] : null;
  };
  for (const component of declared) {
    for (const dependency of component.dependsOn) {
      const name = local(dependency);
      if (name !== null && !names.has(name)) throw new ComponentError("component_dependency_unknown", `The component ${component.name} declared in .prism/workflow.md depends on ${dependency}, which is neither a declared component nor the root component ${root.name}.`, { component: component.name, dependency });
    }
  }
  const edges = (component: Component) => [...new Set(component.dependsOn.map(local).filter((name: string | null) => name !== null))].map((name) => names.get(name!)!);
  for (const start of declared) {
    // The first component in declaration order that lies on a cycle starts it, and a breadth-first walk finds the shortest way back to it.
    const previous = new Map<Component, Component>();
    const queue: Component[] = [start];
    let found = false;
    while (queue.length && !found) {
      const node = queue.shift()!;
      for (const next of edges(node)) {
        if (next === start) { previous.set(start, node); found = true; break; }
        if (!previous.has(next)) { previous.set(next, node); queue.push(next); }
      }
    }
    if (!found) continue;
    const back: Component[] = [start];
    for (let node = previous.get(start)!; node !== start; node = previous.get(node)!) back.push(node);
    const cycle = [start, ...back.slice(1).reverse(), start].map((component) => component.name);
    throw new ComponentError("component_cycle", `The components declared in .prism/workflow.md depend on each other in a cycle: ${cycle.join(" -> ")}.`, { cycle });
  }
  const view = ({ name, identity, folder, testCommand, dependsOn }: Component): Component => ({ name, identity, folder, testCommand, dependsOn: [...dependsOn] });
  const rootComponent = view(root);
  const components = declared.map(view);
  return { repository: repository.name!, root: rootComponent, declared: components, components: [rootComponent, ...components], sharedPaths };
}

/** Whether the configuration lists a component under ## Components, valid or not, rather than only shared paths or nothing. */
export function listsComponents(config: any) {
  return (config?.lines?.Components ?? []).some((line: string) => {
    const top = /^-\s+(.*?)\s*$/.exec(line);
    return top !== null && label(/^([^:]*)/.exec(top[1])![1]) !== "shared paths";
  });
}

/**
 * The components a repository declares, for reading without refusing: { repository, declared, problem? }, where declared lists the root component and then
 * the declared ones in declaration order as { component, folder, testCommand, dependsOn } with dependsOn as identities in the order declared,
 * and an invalid declaration gives an empty declared and problem { code, message }, and repository null when the Repository line itself is invalid.
 */
export function listComponents(config: any) {
  let declaration: ComponentDeclaration;
  try {
    declaration = readComponents(config);
  } catch (error: unknown) {
    if (!(error instanceof ComponentError)) throw error;
    return { repository: repositoryOf(config?.lines?.Workspace ?? []).name ?? null, declared: [], problem: { code: error.code, message: error.message } };
  }
  const identity = (dependency: string) => (dependency.includes("/") ? dependency : `${declaration.repository}/${dependency}`);
  return {
    repository: declaration.repository,
    declared: declaration.components.map((component) => ({ component: component.identity, folder: component.folder, testCommand: component.testCommand, dependsOn: component.dependsOn.map(identity) }))
  };
}

/** The component a project-relative file belongs to: the declared component whose folder holds it, otherwise the root component. */
export function componentOf<C extends { folder: string }>(declaration: { declared: C[]; root: C }, file: string): C {
  const normalized = file.replace(/\/$/, "");
  return declaration.declared.find((component) => inside(normalized, component.folder)) ?? declaration.root;
}

/** Whether a project-relative file equals a shared path or lies inside one. */
export function underSharedPath(declaration: ComponentDeclaration, file: string) {
  const normalized = file.replace(/\/$/, "");
  return declaration.sharedPaths.some((shared) => inside(normalized, shared));
}

/**
 * The component a name gives, bare or as <repository>/<component>, or null when it names no component of this repository.
 */
export function findComponent(declaration: ComponentDeclaration, given: string) {
  const parts = given.split("/");
  if (parts.length > 2) return null;
  if (parts.length === 2 && parts[0] !== declaration.repository) return null;
  const name = parts.at(-1);
  return declaration.components.find((component) => component.name === name) ?? null;
}

// The components of this repository that a component depends on directly: a bare name, or one qualified with this repository's name; a dependency on another repository's component is left out.
function localDependencies(declaration: ComponentDeclaration, component: Component) {
  const named = component.dependsOn.map((dependency: string) => {
    const parts = dependency.split("/");
    return parts.length === 1 ? parts[0] : parts[0] === declaration.repository ? parts[1] : null;
  }).filter((name: string | null) => name !== null);
  return declaration.components.filter((other) => named.includes(other.name));
}

/**
 * The repository's components in dependency order: every component after the components of this repository it depends on, with ties in declaration order, the root component first.
 * A valid declaration has no cycle, so every component is placed.
 */
export function dependencyOrder(declaration: ComponentDeclaration) {
  const placed = new Set<string>();
  const order: Component[] = [];
  while (order.length < declaration.components.length) {
    const next = declaration.components.find((component) => !placed.has(component.identity) && localDependencies(declaration, component).every((dependency) => placed.has(dependency.identity)));
    if (!next) break;
    placed.add(next.identity);
    order.push(next);
  }
  return order;
}

/**
 * The components of this repository that depend, directly or through other components of this repository, on any of the given components, in dependency order.
 * A given component is listed only when it depends on another given one, and a dependency on another repository's component makes nothing depend on it here.
 */
export function dependentsOf(declaration: ComponentDeclaration, components: Component[]) {
  const reached = new Set(components.map((component) => component.identity));
  const dependents = new Set<string>();
  const order = dependencyOrder(declaration);
  // In dependency order every dependency of a component comes before it, so one pass reaches every transitive dependent.
  for (const component of order) {
    if (localDependencies(declaration, component).some((dependency) => reached.has(dependency.identity) || dependents.has(dependency.identity))) dependents.add(component.identity);
  }
  return order.filter((component) => dependents.has(component.identity));
}
