import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { listComponents } from "../workflow/components.mjs";
import { listMachineCheckouts } from "../workflow/machine-checkouts.mjs";
import { managedStoresDirectory, remoteLabel, storeIdentity } from "../workflow/remote-url.mjs";
import { REPOSITORIES, REPOSITORY_NAME } from "../workflow/repository-names.mjs";
import { readStoreWorkspaceName, readWorkspaceName } from "../workflow/roadmap.mjs";
import { readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { workspaceTitle } from "./workspace-identity.mjs";
import { loadAttention } from "./workspace-model.mjs";

// A workspace is one record store on this machine: every registered checkout whose configuration names a store of one identity belongs to it,
// and a checkout that names no store is a workspace of its own.

const sha16 = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** The id of the workspace of a store identity, or of a checkout without a store by its real path. */
export const storeWorkspaceId = (identity) => sha16(`store:${identity}`);
export const projectWorkspaceId = (root) => sha16(`project:${root}`);

/**
 * The workspace a checkout belongs to: { id, kind, identity, url, repository }, kind "store" with the store's identity and the value its configuration names it by,
 * or kind "project" with identity and url null when it names no store or a value that is no store.
 */
export async function checkoutWorkspace(root) {
  const workspace = (await readWorkflowConfig(root).catch(() => null))?.workspace ?? null;
  const configured = workspace?.store ?? null;
  const repository = typeof workspace?.repository === "string" && workspace.repository ? workspace.repository : null;
  const identity = configured === null ? null : await storeIdentity(configured, { root }).catch(() => null);
  if (identity === null) return { id: projectWorkspaceId(root), kind: "project", identity: null, url: null, repository };
  return { id: storeWorkspaceId(identity), kind: "store", identity, url: configured, repository };
}

const real = (target) => realpath(target).catch(() => path.resolve(target));

/** The folder that holds a store's records on this machine: a folder store's real path, or the managed clone of a network store. */
export async function storeFolder(identity, env = process.env) {
  if (identity.startsWith("file:")) return identity.slice("file:".length);
  return real(path.join(managedStoresDirectory(env), sha16(identity)));
}

// The repository names that the store registers, in name order, or none while it cannot be read.
export async function registeredRepositories(folder) {
  const names = await readdir(path.join(folder, REPOSITORIES)).catch(() => []);
  return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).filter((name) => REPOSITORY_NAME.test(name));
}

// A checkout folder that is gone or records that cannot be read give an unknown count rather than a misleading zero.
async function gateCount(root) {
  if (!root || !(await stat(root).then((info) => info.isDirectory(), () => false))) return null;
  return loadAttention(root).then((attention) => attention.gateCount, () => null);
}

/** A workspace's name: the workspace name its store's roadmap record holds, else its store's last segment, else its checkout's folder. */
// A workspace that a person added and that no checkout here serves reads the name from its store's folder.
export async function nameOfWorkspace(view, env = process.env) {
  const workspaceName = view.kind !== "store" ? null : view.root ? await readWorkspaceName(view.root) : await readStoreWorkspaceName(await storeFolder(view.identity, env));
  return workspaceTitle({ workspaceName, identity: view.identity, root: view.root });
}

const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The review app's workspace entries, live workspaces first, then by most recent use, then by name.
 * Each view is { id, kind, identity, urls, root, members, live, lastSeen, added }: members lists its registered checkouts as { root, repository }, root is the checkout it reads records through or null for an added workspace without one,
 * and added is whether a person added it from its store URL.
 * urlOf(id) gives the absolute URL of the workspace's page; no field of an entry names a URL of a checkout, repository, or component.
 */
export async function listWorkspaces(views, { urlOf, env = process.env } = {}) {
  const machine = await listMachineCheckouts(env).catch(() => []);
  const entries = await Promise.all(views.map(async (view) => {
    const registered = view.members.map((member) => member.root);
    const byRepository = new Map();
    const note = (name, root) => {
      if (!name) return;
      if (!byRepository.has(name)) byRepository.set(name, new Set());
      if (root) byRepository.get(name).add(root);
    };
    for (const member of view.members) note(member.repository, member.root);
    let checkouts = registered;
    let store = null;
    if (view.kind === "store") {
      const folder = await storeFolder(view.identity, env);
      for (const name of await registeredRepositories(folder)) note(name, null);
      const listed = machine.filter((entry) => entry.store === folder);
      for (const entry of listed) note(entry.repository, entry.path);
      checkouts = [...new Set([...registered, ...listed.map((entry) => entry.path)])];
      store = { identity: view.identity, label: remoteLabel(view.urls[0]) ?? view.urls[0] ?? view.identity, urls: [...view.urls] };
    }
    return {
      entry: {
        id: view.id,
        name: await nameOfWorkspace(view, env),
        kind: view.kind,
        added: view.added === true,
        live: view.live,
        gates: await gateCount(view.root),
        store,
        repositories: [...byRepository].sort(([left], [right]) => byText(left, right)).map(([name, roots]) => ({ name, checkouts: [...roots].sort(byText) })),
        checkouts,
        url: urlOf(view.id)
      },
      lastSeen: view.lastSeen
    };
  }));
  entries.sort((left, right) => Number(right.entry.live) - Number(left.entry.live) || right.lastSeen - left.lastSeen || collator.compare(left.entry.name, right.entry.name));
  return entries.map(({ entry }) => entry);
}

/**
 * A workspace's checkouts on this machine, each { root, repository } once by its real path: the given registered checkouts in their order,
 * then the entries of the machine's checkout list for the store folder whose folder still holds a configuration that names that store and repository.
 */
export async function checkoutsOnMachine(registered, folder, env = process.env) {
  const listed = folder === null ? [] : (await listMachineCheckouts(env).catch(() => [])).filter((entry) => entry.store === folder).map((entry) => ({ root: entry.path, repository: entry.repository }));
  const seen = new Map();
  for (const checkout of [...registered, ...listed]) {
    const root = await real(checkout.root);
    if (!seen.has(root)) seen.set(root, { root, repository: checkout.repository ?? null });
  }
  return [...seen.values()];
}

/**
 * The components a workspace knows, sorted by identity, each { identity, repository, root }: the components of each checkout on this machine, root the first checkout that declares it,
 * each code clone's declared components and each component scope folder of the store, root null, and the root component <repository>/<repository> of each repository.
 * checkouts lists { root } of this machine's checkouts, repositories the workspace's repository names, scopes the store's scopes, and clones(repository), when code content exists,
 * the clone's declared components as code/components answers them, or null without a clone.
 */
export async function knownComponents({ checkouts = [], repositories = [], scopes = [], clones = null }) {
  const known = new Map();
  const note = (identity, root = null) => {
    const [repository, component] = identity.split("/");
    if (!REPOSITORY_NAME.test(repository ?? "") || !REPOSITORY_NAME.test(component ?? "")) return;
    const entry = known.get(identity);
    if (!entry) known.set(identity, { identity, repository, root });
    else if (entry.root === null && root !== null) entry.root = root;
  };
  for (const { root } of checkouts) {
    const listed = listComponents(await readWorkflowConfig(root).catch(() => null));
    const repository = listed.repository ?? "root";
    note(`${repository}/${repository}`, root);
    for (const component of listed.declared) note(component.component, root);
  }
  for (const scope of scopes) if (scope.kind === "component" && scope.repository && scope.component) note(`${scope.repository}/${scope.component}`);
  const names = new Set([...repositories, ...[...known.values()].map((entry) => entry.repository)]);
  if (clones) {
    for (const repository of names) for (const component of (await Promise.resolve(clones(repository)).catch(() => null))?.components ?? []) note(component.identity);
  }
  for (const repository of names) note(`${repository}/${repository}`);
  return [...known.values()].sort((left, right) => byText(left.identity, right.identity));
}
