import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeServers, prismServer, storeFolder } from "./fixtures/repository-checkouts.mjs";

// Requirements: docs/requirements/components.md §1, §2.
// Contract: docs/plans/components/component-slices/slice.md clauses 32 and 33.
// Each checkout's configuration is written here line by line, so no fixture default decides whether it names a repository.

const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-required-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
test.after(() => rm(environment, { recursive: true, force: true }));

const { describeRecordStore, recordsUnavailable, recordStoreOf } = await import("../../dist/server/workflow/record-store.mjs");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

async function place(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-required-")));
  context.after(async () => { await closeServers(); await rm(parent, { recursive: true, force: true }); });
  return { parent, app: path.join(parent, "app"), store: await storeFolder(parent) };
}

const config = (workspace) => `## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: ${process.execPath} check.mjs\n${workspace.length ? `\n## Workspace\n${workspace.join("\n")}\n` : ""}`;

/** A repository with its own root commit, an optional origin, and the given Workspace lines, committed. */
async function checkout(parent, name, { remote = null, workspace = ["- Store: ../store"], from = null } = {}) {
  const root = path.join(parent, name);
  if (from) git(parent, "clone", "-q", from, root);
  else {
    await mkdir(path.join(root, ".prism"), { recursive: true });
    await writeFile(path.join(root, "README.md"), `# ${name}\n`);
    await writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
    git(root, "init", "-q", "-b", "main");
  }
  if (from && remote) git(root, "remote", "set-url", "origin", remote);
  else if (remote) git(root, "remote", "add", "origin", remote);
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), config(workspace));
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", `configure ${name}`);
  return realpath(root);
}

/** Every file under a folder, outside .git, by relative path. */
async function files(folder) {
  const found = [];
  const visit = async (relative) => {
    let entries = [];
    try { entries = await readdir(path.join(folder, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) await visit(child);
      else found.push([child, await readFile(path.join(folder, child), "utf8")]);
    }
  };
  await visit("");
  return found.sort(([left], [right]) => left.localeCompare(right));
}

const create = (server, slug) => server.call("update_initiative", { initiative: slug, expectedRevision: null, operations: [{ op: "create", slug, title: "Reports", requirements: ["r.md#1"] }] });

test("clause 32: a checkout that names a store but no repository is refused on every record operation with the line to add", async (context) => {
  const at = await place(context);
  const core = await checkout(at.parent, "core", { remote: "https://github.com/acme/platform-core.git", workspace: ["- Store: ../store", "- Repository: core"] });
  const named = await prismServer(context, core, { appFolder: at.app });
  assert.equal((await create(named, "core-work")).error, undefined, "a named checkout works");
  const cases = [
    [await checkout(at.parent, "api", { remote: "git@github.com:acme/API.git" }), "api"],
    [await checkout(at.parent, "core-clone", { remote: "git@github.com:acme/platform-core.git" }), "core"],
    [await checkout(at.parent, "core-moved", { from: core, remote: "https://github.com/acme/core-next.git" }), "core"],
    [await checkout(at.parent, "beta", { remote: "https://github.com/beta/core.git" }), "core-2"],
    [await checkout(at.parent, "Notes App"), "notes-app"]
  ];
  const before = await files(at.store);
  for (const [root, proposed] of cases) {
    const server = await prismServer(context, root, { appFolder: at.app });
    for (const [name, args] of [["get_roadmap", {}], ["get_initiative", { initiative: "reports" }], ["update_initiative", { initiative: "reports", expectedRevision: null, operations: [{ op: "create", slug: "reports", title: "Reports", requirements: ["r.md#1"] }] }], ["get_coordination_state", { initiative: "reports" }]]) {
      const response = await server.call(name, args);
      assert.ok(response.error, `${root}: ${name} is refused`);
      assert.equal(response.error.data?.code, "repository_name_missing", `${root}: ${name}: ${response.error.message}`);
      assert.equal(response.error.data.proposed, proposed, `${root} proposes ${proposed}`);
      assert.ok(response.error.message.includes(`- Repository: ${proposed}`), response.error.message);
      assert.match(response.error.message, /## Workspace/);
    }
    await assert.rejects(recordStoreOf(root), (error) => error.code === "repository_name_missing" && error.proposed === proposed && recordsUnavailable(error));
    const described = await describeRecordStore(root);
    assert.equal(described.location, null);
    assert.ok(described.unavailable.includes(`- Repository: ${proposed}`), "the review browser shows the store as unavailable with the refusal");
    assert.equal(JSON.stringify(await files(path.join(root, ".prism"))).includes("initiatives"), false, "the checkout keeps no records of its own instead");
  }
  assert.deepEqual(await files(at.store), before, "nothing was written to the store");

  const [api] = cases[0];
  await writeFile(path.join(api, ".prism", "workflow.md"), config(["- Store: ../store", "- Repository: api"]));
  git(api, "commit", "-qam", "name the repository");
  const fixed = await prismServer(context, api, { appFolder: at.app });
  const response = await create(fixed, "reports");
  assert.equal(response.error, undefined, response.error?.message);
  assert.equal((response.result.content ?? []).slice(1).some((item) => /Repository/.test(item.text)), false, "no warning is added");
});

test("clause 33: a checkout without a store needs no repository name, and a Repository line without a store is ignored", async (context) => {
  const at = await place(context);
  for (const [name, workspace] of [["plain", []], ["ignored", ["- Repository: Not A Valid Name"]]]) {
    const root = await checkout(at.parent, name, { remote: `https://github.com/acme/${name}.git`, workspace });
    const server = await prismServer(context, root, { appFolder: at.app });
    const response = await create(server, "reports");
    assert.equal(response.error, undefined, response.error?.message);
    assert.equal((response.result.content ?? []).slice(1).map((item) => item.text).join("\n"), "", "no warning or note is added");
    assert.equal((await recordStoreOf(root)).repository, null);
  }
});
