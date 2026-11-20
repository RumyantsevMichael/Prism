// Generated from src/server/review/workspaces.mts by scripts/native-build/compile.mjs.
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
const sha16 = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const storeWorkspaceId = (identity) => sha16(`store:${identity}`);
const projectWorkspaceId = (root) => sha16(`project:${root}`);
async function checkoutWorkspace(root) {
  const workspace = (await readWorkflowConfig(root).catch(() => null))?.workspace ?? null;
  const configured = workspace?.store ?? null;
  const repository = typeof workspace?.repository === "string" && workspace.repository ? workspace.repository : null;
  const identity = configured === null ? null : await storeIdentity(configured, { root }).catch(() => null);
  if (identity === null) return { id: projectWorkspaceId(root), kind: "project", identity: null, url: null, repository };
  return { id: storeWorkspaceId(identity), kind: "store", identity, url: configured, repository };
}
const real = (target) => realpath(target).catch(() => path.resolve(target));
async function storeFolder(identity, env = process.env) {
  if (identity.startsWith("file:")) return identity.slice("file:".length);
  return real(path.join(managedStoresDirectory(env), sha16(identity)));
}
async function registeredRepositories(folder) {
  const names = await readdir(path.join(folder, REPOSITORIES)).catch(() => []);
  return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).filter((name) => REPOSITORY_NAME.test(name));
}
async function gateCount(root) {
  if (!root || !await stat(root).then((info) => info.isDirectory(), () => false)) return null;
  return loadAttention(root).then((attention) => attention.gateCount, () => null);
}
async function nameOfWorkspace(view, env = process.env) {
  const workspaceName = view.kind !== "store" ? null : view.root ? await readWorkspaceName(view.root) : await readStoreWorkspaceName(await storeFolder(view.identity, env));
  return workspaceTitle({ workspaceName, identity: view.identity, root: view.root });
}
const byText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const collator = new Intl.Collator(void 0, { numeric: true, sensitivity: "base" });
async function listWorkspaces(views, { urlOf, env = process.env } = {}) {
  const machine = await listMachineCheckouts(env).catch(() => []);
  const entries = await Promise.all(views.map(async (view) => {
    const registered = view.members.map((member) => member.root);
    const byRepository = /* @__PURE__ */ new Map();
    const note = (name, root) => {
      if (!name) return;
      if (!byRepository.has(name)) byRepository.set(name, /* @__PURE__ */ new Set());
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
      checkouts = [.../* @__PURE__ */ new Set([...registered, ...listed.map((entry) => entry.path)])];
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
async function checkoutsOnMachine(registered, folder, env = process.env) {
  const listed = folder === null ? [] : (await listMachineCheckouts(env).catch(() => [])).filter((entry) => entry.store === folder).map((entry) => ({ root: entry.path, repository: entry.repository }));
  const seen = /* @__PURE__ */ new Map();
  for (const checkout of [...registered, ...listed]) {
    const root = await real(checkout.root);
    if (!seen.has(root)) seen.set(root, { root, repository: checkout.repository ?? null });
  }
  return [...seen.values()];
}
async function knownComponents({ checkouts = [], repositories = [], scopes = [], clones = null }) {
  const known = /* @__PURE__ */ new Map();
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
  const names = /* @__PURE__ */ new Set([...repositories, ...[...known.values()].map((entry) => entry.repository)]);
  if (clones) {
    for (const repository of names) for (const component of (await Promise.resolve(clones(repository)).catch(() => null))?.components ?? []) note(component.identity);
  }
  for (const repository of names) note(`${repository}/${repository}`);
  return [...known.values()].sort((left, right) => byText(left.identity, right.identity));
}
export {
  checkoutWorkspace,
  checkoutsOnMachine,
  knownComponents,
  listWorkspaces,
  nameOfWorkspace,
  projectWorkspaceId,
  registeredRepositories,
  storeFolder,
  storeWorkspaceId
};
