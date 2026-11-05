import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeServers, cloneOf, configure, createInitiative, git, notes, prismServer, registration, repository, snapshot, storeFolder } from "./fixtures/repository-checkouts.mjs";
import { splitEvidence } from "./fixtures/split-evidence.mjs";

// Git runs with a private home and configuration, a fixed identity, and only local repositories; each test has its own Prism application folder.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-names-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
test.after(() => rm(environment, { recursive: true, force: true }));

const exists = (target) => access(target).then(() => true, () => false);
const root = (checkout) => git(checkout, "rev-list", "--max-parents=0", "HEAD");
const ok = (response) => { assert.equal(response.error, undefined, response.error?.message); return response; };
const refused = (response, code) => { assert.ok(response.error, `expected ${code}, got a result`); assert.equal(response.error.data?.code, code, response.error.message); return response.error; };

async function folder(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-names-")));
  context.after(async () => { await closeServers(); await rm(parent, { recursive: true, force: true }); });
  return { parent, app: path.join(parent, "app"), store: await storeFolder(parent) };
}

const server = (context, place, checkout, options = {}) => prismServer(context, checkout, { appFolder: place.app, ...options });

test("two repositories share one store under their own names, and a third that takes a name with another history is refused", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://user:secret-token@github.com/acme/api.git", repository: "api" });
  const web = await repository(place.parent, "web", { remote: "git@github.com:acme/web.git", repository: "web" });
  ok(await createInitiative(await server(context, place, api), "api-work"));
  ok(await createInitiative(await server(context, place, web), "web-work"));
  const apiRegistration = await registration(place.store, "api");
  assert.deepEqual(Object.keys(apiRegistration).sort(), ["name", "registeredAt", "remotes", "root", "schemaVersion"]);
  assert.equal(apiRegistration.schemaVersion, 1);
  assert.equal(apiRegistration.name, "api");
  assert.deepEqual(apiRegistration.remotes, ["https://github.com/acme/api.git"], "the remote keeps its scheme, host, and path and loses its user information");
  assert.equal(apiRegistration.root, root(api));
  assert.ok(Number.isFinite(Date.parse(apiRegistration.registeredAt)));
  assert.equal((await readFile(path.join(place.store, "repositories", "api.json"), "utf8")).endsWith("}\n"), true);
  const webRegistration = await registration(place.store, "web");
  assert.deepEqual([webRegistration.name, webRegistration.remotes, webRegistration.root], ["web", ["github.com:acme/web.git"], root(web)]);
  for (const id of ["api-work", "web-work"]) assert.ok(await exists(path.join(place.store, "initiatives", id, "initiative.json")), "both repositories write the one store");

  // A third repository with its own history and remote names itself api, and keeps an in-repo record that a migration would move.
  const other = await repository(place.parent, "other", { remote: "https://github.com/beta/api.git", repository: "api" });
  await mkdir(path.join(other, ".prism", "initiatives", "kept"), { recursive: true });
  await writeFile(path.join(other, ".prism", "initiatives", "kept", "initiative.json"), "{\"kept\":true}\n");
  const before = await snapshot(place.store);
  const third = await server(context, place, other);
  for (const response of [await third.call("get_roadmap"), await createInitiative(third, "other-work")]) {
    const error = refused(response, "repository_name_taken");
    assert.match(error.message, /repository name api/);
    assert.match(error.message, /https:\/\/github\.com\/acme\/api\.git/, "the message names the registered remote");
    assert.match(error.message, /https:\/\/github\.com\/beta\/api\.git/, "the message names this checkout's remote");
    assert.doesNotMatch(error.message, /secret-token|user:/);
    assert.match(error.message, /git fetch --unshallow/);
    assert.match(error.message, /- Repository: api-2/);
    assert.equal(error.data.proposed, "api-2");
  }
  assert.deepEqual(await snapshot(place.store), before, "a refused checkout changes nothing in the store");
  assert.equal(await readFile(path.join(other, ".prism", "initiatives", "kept", "initiative.json"), "utf8"), "{\"kept\":true}\n", "a refused checkout migrates nothing");
});

test("SSH and HTTPS spellings of one host and path are one remote", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "git@github.com:acme/api.git", repository: "api" });
  ok(await (await server(context, place, api)).call("get_roadmap"));
  // Another repository's history under a spelling of the same remote still matches by its remote.
  for (const [name, remote] of [["https", "https://GitHub.com/acme/api"], ["ssh", "ssh://git@github.com:22/acme/api.git/"], ["git", "git://github.com/acme/api.git"]]) {
    const checkout = await repository(place.parent, name, { remote, repository: "api" });
    ok(await (await server(context, place, checkout)).call("get_roadmap"));
  }
  assert.deepEqual((await registration(place.store, "api")).remotes, ["github.com:acme/api.git"], "a spelling of a registered remote is not added again");
  // The path keeps its case, so a remote whose path differs only in case is another remote.
  const upper = await repository(place.parent, "upper", { remote: "https://github.com/Acme/API.git", repository: "api" });
  refused(await (await server(context, place, upper)).call("get_roadmap"), "repository_name_taken");
});

test("a repository moved on its host keeps its name when its root commit proves it", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  ok(await (await server(context, place, api)).call("get_roadmap"));
  const moved = await cloneOf(api, place.parent, "moved", { remote: "https://github.com/acme/platform-api.git" });
  ok(await (await server(context, place, moved)).call("get_roadmap"));
  assert.deepEqual((await registration(place.store, "api")).remotes, ["https://github.com/acme/api.git", "https://github.com/acme/platform-api.git"], "the new remote joins the registration");
  // A fork shares the root commit, so it joins the same registration.
  const fork = await cloneOf(api, place.parent, "fork", { remote: "git@github.com:someone/api.git" });
  ok(await (await server(context, place, fork)).call("get_roadmap"));
  assert.equal((await registration(place.store, "api")).remotes.length, 3);
  // A shallow clone cannot prove its history under another remote, but one of the registered remotes is enough.
  const shallow = await cloneOf(api, place.parent, "shallow", { shallow: true, remote: "https://github.com/acme/api-mirror.git" });
  const error = refused(await (await server(context, place, shallow)).call("get_roadmap"), "repository_name_taken");
  assert.match(error.message, /shallow/);
  assert.match(error.message, /git fetch --unshallow/);
  const shallowKnown = await cloneOf(api, place.parent, "shallow-known", { shallow: true, remote: "https://github.com/acme/platform-api.git" });
  ok(await (await server(context, place, shallowKnown)).call("get_roadmap"));
  assert.equal((await registration(place.store, "api")).remotes.length, 3, "neither shallow clone changed the registration");
});

test("a registration from a shallow clone takes the root commit of the first full checkout with its remote", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git" });
  const shallow = await cloneOf(api, place.parent, "shallow", { shallow: true, remote: "https://github.com/acme/api.git", repository: "api" });
  ok(await (await server(context, place, shallow)).call("get_roadmap"));
  assert.equal((await registration(place.store, "api")).root, null, "a shallow clone has no root commit to record");
  const moved = await cloneOf(api, place.parent, "moved", { remote: "https://github.com/acme/api-renamed.git" });
  await configure(moved, { repository: "api" });
  const unproven = refused(await (await server(context, place, moved)).call("get_roadmap"), "repository_name_taken");
  assert.match(unproven.message, /no root commit/);
  const full = await cloneOf(api, place.parent, "full", { remote: "https://github.com/acme/api.git" });
  await configure(full, { repository: "api" });
  ok(await (await server(context, place, full)).call("get_roadmap"));
  assert.equal((await registration(place.store, "api")).root, root(api));
  ok(await (await server(context, place, moved)).call("get_roadmap"), "the move is proven once the registration has a root commit");
});

test("a repository without a network remote registers its name without one", async (context) => {
  const place = await folder(context);
  const journal = await repository(place.parent, "notes", { repository: "notes" });
  ok(await createInitiative(await server(context, place, journal)));
  assert.deepEqual((await registration(place.store, "notes")).remotes, []);
  // A local path or file:// origin is no network remote, so these checkouts match the registration whatever their history.
  for (const [name, remote] of [["local-path", path.join(place.parent, "elsewhere.git")], ["file-url", "file:///srv/git/notes.git"]]) {
    const checkout = await repository(place.parent, name, { remote, repository: "notes" });
    ok(await (await server(context, place, checkout)).call("get_roadmap"));
  }
  assert.deepEqual((await registration(place.store, "notes")).remotes, []);
  // A networked checkout with another history is refused, and the message says the name has no network remote.
  const networked = await repository(place.parent, "networked", { remote: "https://github.com/acme/notes.git", repository: "notes" });
  const error = refused(await (await server(context, place, networked)).call("get_roadmap"), "repository_name_taken");
  assert.match(error.message, /no network remote/);
  // A clone of the same history that gained a network remote joins the registration.
  const published = await cloneOf(journal, place.parent, "published", { remote: "https://github.com/acme/notes-published.git" });
  ok(await (await server(context, place, published)).call("get_roadmap"));
  assert.deepEqual((await registration(place.store, "notes")).remotes, ["https://github.com/acme/notes-published.git"]);
});

test("one remote cannot take a second name", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  ok(await (await server(context, place, api)).call("get_roadmap"));
  const renamed = await cloneOf(api, place.parent, "renamed", { remote: "git@github.com:acme/api.git", repository: "backend" });
  const before = await snapshot(place.store);
  const error = refused(await (await server(context, place, renamed)).call("get_roadmap"), "repository_remote_registered");
  assert.match(error.message, /registered in the record store as repository api/);
  assert.match(error.message, /- Repository: api/);
  assert.equal(error.data.proposed, "api");
  assert.deepEqual(await snapshot(place.store), before);
  assert.equal(await registration(place.store, "backend"), null);
});

test("a root commit does not move a remote that another name registered", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  ok(await (await server(context, place, api)).call("get_roadmap"));
  // A fork shares the original's root commit but registers under a name of its own.
  const fork = await cloneOf(api, place.parent, "fork", { remote: "https://github.com/someone/api-fork.git", repository: "api-fork" });
  ok(await (await server(context, place, fork)).call("get_roadmap"));
  assert.deepEqual((await registration(place.store, "api-fork")).remotes, ["https://github.com/someone/api-fork.git"]);
  // A checkout of the fork that names the original would put the fork's remote under two names.
  const confused = await cloneOf(fork, place.parent, "confused", { remote: "git@github.com:someone/api-fork.git", repository: "api" });
  const before = await snapshot(place.store);
  const error = refused(await (await server(context, place, confused)).call("get_roadmap"), "repository_remote_registered");
  assert.match(error.message, /registered in the record store as repository api-fork/);
  assert.match(error.message, /- Repository: api-fork/);
  assert.equal(error.data.proposed, "api-fork");
  assert.deepEqual(await snapshot(place.store), before, "neither registration changed");
  assert.deepEqual((await registration(place.store, "api")).remotes, ["https://github.com/acme/api.git"]);
});

test("an invalid repository name is refused with a valid proposal", async (context) => {
  const place = await folder(context);
  for (const [name, value] of [["spaces", "Web App"], ["slash", "acme/web"], ["dash", "-web"], ["long", "w".repeat(65)]]) {
    const checkout = await repository(place.parent, name, { remote: `https://github.com/acme/${name}-web.git`, repository: value });
    const error = refused(await (await server(context, place, checkout)).call("get_roadmap"), "repository_name_invalid");
    assert.match(error.message, /lowercase letters, digits, hyphens, or underscores/);
    assert.match(error.message, new RegExp(`- Repository: ${name}-web`));
    assert.equal(error.data.proposed, `${name}-web`);
  }
  assert.deepEqual(await snapshot(place.store), {}, "nothing was written to the store");
  const longest = await repository(place.parent, "longest", { remote: "https://github.com/acme/longest.git", repository: `a${"b".repeat(62)}c` });
  ok(await (await server(context, place, longest)).call("get_roadmap"), "64 characters is a valid name");
});

test("a checkout without a repository name is refused on every record operation with the line to add", async (context) => {
  const place = await folder(context);
  const core = await repository(place.parent, "core", { remote: "https://github.com/acme/platform-core.git", repository: "core" });
  ok(await (await server(context, place, core)).call("get_roadmap"));
  const cases = [
    // The last path segment of the remote, without .git.
    [await repository(place.parent, "api", { remote: "git@github.com:acme/API.git" }), "api"],
    // A checkout whose remote a registration lists gets that name, even under another spelling.
    [await repository(place.parent, "core-clone", { remote: "git@github.com:acme/platform-core.git" }), "core"],
    // A clone of a registered repository moved to another remote gets the registration that its root commit proves.
    // Its configuration names the store without the Repository line that the clone inherited.
    [await cloneOf(core, place.parent, "core-moved", { remote: "https://github.com/acme/core-next.git", store: "../store" }), "core"],
    // A segment registered for another repository gets the first free suffix.
    [await repository(place.parent, "beta", { remote: "https://github.com/beta/core.git" }), "core-2"],
    // Without a network remote, the checkout folder's name.
    [await repository(place.parent, "Notes App", {}), "notes-app"],
    // A remote without a path segment also falls back to the folder name.
    [await repository(place.parent, "bare-host", { remote: "https://git.example.com/" }), "bare-host"]
  ];
  const before = await snapshot(place.store);
  for (const [checkout, proposed] of cases) {
    const unnamed = await server(context, place, checkout);
    for (const response of [await unnamed.call("get_roadmap"), await createInitiative(unnamed, `work-${path.basename(checkout).replace(/\W/g, "").toLowerCase()}`)]) {
      const error = refused(response, "repository_name_missing");
      assert.equal(error.data.proposed, proposed, `${checkout} proposes ${proposed}`);
      assert.ok(error.message.includes(`- Repository: ${proposed}`), error.message);
      assert.match(error.message, /## Workspace/);
    }
  }
  assert.deepEqual(await snapshot(place.store), before, "an unnamed checkout writes nothing to the store");
  assert.deepEqual((await readdir(path.join(place.store, "repositories"))).sort(), ["core.json"], "an unnamed checkout registers nothing");
  assert.equal(notes(ok(await (await server(context, place, core)).call("get_roadmap"))), "", "a named checkout gets no warning");
});

// An initiative whose download slice has a started, accepted design, written through the server.
async function startedSlice(serverInstance, checkout) {
  const evidence = await splitEvidence(checkout, "docs/plans/reports", "download");
  ok(await serverInstance.call("update_initiative", { initiative: "reports", expectedRevision: null, operations: [
    { op: "create", slug: "reports", title: "Reports", requirements: ["r.md#1", "r.md#2"] },
    { op: "split", parent: "reports", children: [{ slug: "download", title: "Download", requirements: ["r.md#1"] }, { slug: "audit", title: "Audit", requirements: ["r.md#2"] }], evidence }
  ] }));
  const current = ok(await serverInstance.call("get_initiative", { initiative: "reports" })).result.structuredContent;
  ok(await serverInstance.call("update_initiative", { initiative: "reports", expectedRevision: current.revision, operations: [{ op: "set_status", slug: "download", status: "in-progress" }, { op: "accept_design", slug: "download", frozenTests: ["test/acceptance.test.mjs"], review: "none" }] }));
}

const runEntries = async (store) => {
  const folder = path.join(store, "initiatives", "reports", "slices", "download", "runs");
  return Promise.all((await readdir(folder)).sort().map(async (name) => JSON.parse(await readFile(path.join(folder, name), "utf8"))));
};

test("a named checkout records its name as the repository of its runs, and an unnamed one records nothing", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  const named = await server(context, place, api);
  await startedSlice(named, api);
  ok(await named.call("verify_slice", { initiative: "reports", slice: "download", contractDefects: [{ clause: "§1", reason: "named" }] }));
  const [defect] = await runEntries(place.store);
  assert.equal(defect.kind, "contract-defect");
  assert.equal(defect.checkout.repository, "api");
  assert.equal(defect.checkout.remote, "https://github.com/acme/api.git");

  const other = await folder(context);
  const unnamedCheckout = await repository(other.parent, "web", { remote: "https://github.com/acme/web.git" });
  const unnamed = await server(context, other, unnamedCheckout);
  refused(await createInitiative(unnamed), "repository_name_missing");
  refused(await unnamed.call("verify_slice", { initiative: "reports", slice: "download", contractDefects: [{ clause: "§1", reason: "unnamed" }] }), "repository_name_missing");
  assert.deepEqual(await snapshot(other.store), {}, "the store holds no run, record, or registration");
});

test("naming a refused repository moves its in-repo records into the store and adds only them, its ledger entry, the store's housekeeping files, and its registration", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git" });
  // An M1 checkout: its in-repo record stays where it is while the checkout names no repository.
  await mkdir(path.join(api, ".prism", "initiatives", "legacy"), { recursive: true });
  await writeFile(path.join(api, ".prism", "initiatives", "legacy", "initiative.json"), "{\"legacy\":true}\n");
  const before = await server(context, place, api);
  refused(await before.call("get_roadmap"), "repository_name_missing");
  refused(await createInitiative(before), "repository_name_missing");
  await before.close();
  assert.deepEqual(await snapshot(place.store), {}, "the refused checkout wrote nothing to the store");
  assert.ok(await exists(path.join(api, ".prism", "initiatives", "legacy", "initiative.json")), "the refused checkout kept its in-repo record");

  await configure(api, { repository: "api" });
  ok(await (await server(context, place, api)).call("get_roadmap"));
  const now = await snapshot(place.store);
  assert.equal(now["initiatives/legacy/initiative.json"], "{\"legacy\":true}\n", "the in-repo record moved into the store");
  const ledger = Object.keys(now).filter((file) => file.startsWith("migrations/"));
  assert.equal(ledger.length, 1, "the migration wrote one ledger entry");
  assert.deepEqual(JSON.parse(now[ledger[0]]).records, [".prism/initiatives/legacy/initiative.json"]);
  assert.deepEqual(Object.keys(now).sort(), [".gitattributes", ".gitignore", "initiatives/legacy/initiative.json", ledger[0], "repositories/api.json"].sort(), "naming adds nothing else");
  assert.equal(await exists(path.join(api, ".prism", "initiatives", "legacy")), false, "the moved record left the checkout");
});

test("naming a repository keeps every record, ledger entry, and run that an earlier release's unnamed checkout left in its store unchanged and readable, and adds only the registration", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git" });
  // Records and a run written without a store, then moved into the store with a ledger entry, as an earlier release's unnamed checkout left them.
  await writeFile(path.join(api, ".prism", "workflow.md"), `## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: ${process.execPath} check.mjs\n`);
  git(api, "add", "-A");
  git(api, "commit", "-q", "-m", "use no store");
  const storeless = await server(context, place, api);
  await startedSlice(storeless, api);
  ok(await storeless.call("verify_slice", { initiative: "reports", slice: "download", contractDefects: [{ clause: "§1", reason: "before names" }] }));
  const initiativeBefore = ok(await storeless.call("get_initiative", { initiative: "reports" })).result.structuredContent;
  await storeless.close();
  const inRepo = await snapshot(path.join(api, ".prism", "initiatives"));
  const records = Object.keys(inRepo).sort().map((file) => `.prism/initiatives/${file}`);
  assert.ok(records.some((file) => file.includes("/runs/")), "the seeded records hold a run");
  for (const [file, bytes] of Object.entries(inRepo)) {
    await mkdir(path.dirname(path.join(place.store, "initiatives", file)), { recursive: true });
    await writeFile(path.join(place.store, "initiatives", file), bytes);
  }
  await rm(path.join(api, ".prism", "initiatives"), { recursive: true, force: true });
  await mkdir(path.join(place.store, "migrations"), { recursive: true });
  await writeFile(path.join(place.store, "migrations", "2026-10-31T10-00-00-000Z-0a1b2c3d.json"), `${JSON.stringify({ schemaVersion: 2, repository: root(api), migratedAt: "2026-10-31T10:00:00.000Z", moved: records.length, records, conflicts: [] }, null, 2)}\n`);
  await writeFile(path.join(place.store, ".gitattributes"), "/initiatives/** linguist-generated=true\n");
  await writeFile(path.join(place.store, ".gitignore"), "*.lock\n");
  const stored = await snapshot(place.store);
  assert.equal((await runEntries(place.store))[0].checkout.repository, root(api), "the seeded run names its repository by root commit");

  await configure(api, { repository: "api" });
  const after = await server(context, place, api);
  const initiativeAfter = ok(await after.call("get_initiative", { initiative: "reports" })).result.structuredContent;
  assert.equal(initiativeAfter.revision, initiativeBefore.revision);
  assert.deepEqual(initiativeAfter.record, initiativeBefore.record);
  const now = await snapshot(place.store);
  for (const [file, bytes] of Object.entries(stored)) assert.equal(now[file], bytes, `${file} is unchanged`);
  assert.deepEqual(Object.keys(now).filter((file) => !(file in stored)), ["repositories/api.json"], "naming adds only the registration");
  assert.equal((await runEntries(place.store))[0].checkout.repository, root(api), "a run from before the name keeps its root-commit repository");
});

test("a migration marker from before the ledger keeps covering its repository after the repository is named", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  // A pre-ledger store named the repository it migrated by its root commit, without the record paths.
  await mkdir(path.join(place.store, "migrations"), { recursive: true });
  await writeFile(path.join(place.store, "migrations", `${root(api)}.json`), `${JSON.stringify({ repository: root(api), migratedAt: "2026-10-31T10:00:00.000Z", moved: 1 })}\n`);
  await mkdir(path.join(api, ".prism", "initiatives", "removed"), { recursive: true });
  await writeFile(path.join(api, ".prism", "initiatives", "removed", "initiative.json"), "{\"removed\":true}\n");
  ok(await createInitiative(await server(context, place, api), "fresh"));
  assert.equal(await exists(path.join(place.store, "initiatives", "removed")), false, "a record people removed from the store does not come back");
  assert.ok(await exists(path.join(api, ".prism", "initiatives", "removed", "initiative.json")));
  assert.ok(await exists(path.join(place.store, "initiatives", "fresh", "initiative.json")));
});

test("a change to the repository name applies to a running server within five seconds", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  const running = await server(context, place, api);
  ok(await running.call("get_roadmap"));
  await configure(api, { repository: "Not Valid" });
  await new Promise((resolve) => setTimeout(resolve, 5500));
  refused(await running.call("get_roadmap"), "repository_name_invalid");
});

test("without a store, a Repository line changes nothing", async (context) => {
  const place = await folder(context);
  const solo = await repository(place.parent, "solo", { remote: "https://github.com/acme/solo.git" });
  await writeFile(path.join(solo, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans\n\n## Workspace\n- Repository: Not Valid\n");
  const response = ok(await createInitiative(await server(context, place, solo)));
  assert.equal(notes(response), "");
  assert.ok(await exists(path.join(solo, ".prism", "initiatives", "reports", "initiative.json")));
  assert.deepEqual(await snapshot(place.store), {});
});
