import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { publicRemote } from "./remote-url.mjs";

// A checkout names its repository to its record store, which registers each name with the remotes and root commit that prove which repository it is.
// The registrations live in a folder of their own at the store root, never under a .prism address, so no record path can collide with them.
export const REPOSITORIES = "repositories";
// No name holds "/", which a later increment uses in <repository>/<component>.
export const REPOSITORY_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const NAME_MAX = 64;
const REGISTRATION_MAX_BYTES = 64 * 1024;
// The refusals of a named checkout, which every record operation reports while the checkout stays refused.
export const REPOSITORY_REFUSALS = Object.freeze(["repository_name_invalid", "repository_remote_registered", "repository_name_taken"]);

const git = (root, args) => new Promise((resolve) => {
  execFile("git", ["-C", root, ...args], { timeout: 10000 }, (error, stdout) => resolve(error ? null : stdout.trim()));
});

/** The identity every full clone of one repository shares, its first root commit in sorted order, or null outside Git, before the first commit, or in a shallow clone, whose oldest fetched commits only look like roots. */
// A root commit never changes once it exists, so each project asks Git only until it has one; a shallow clone asks again, because git fetch --unshallow reveals its root.
const repositoryIds = new Map();
async function rootCommit(root, shallow) {
  if (repositoryIds.has(root)) return repositoryIds.get(root);
  if (shallow !== "false") return null;
  const id = ((await git(root, ["rev-list", "--max-parents=0", "HEAD"])) ?? "").split(/\s+/).filter(Boolean).sort()[0] || null;
  if (id) repositoryIds.set(root, id);
  return id;
}
export async function repositoryId(root) {
  if (repositoryIds.has(root)) return repositoryIds.get(root);
  return rootCommit(root, await git(root, ["rev-parse", "--is-shallow-repository"]));
}

/**
 * The identity of a remote as shown in records: its lowercase host without a port and its path without surrounding slashes or a trailing .git.
 * Scheme and user never count, so SSH and HTTPS spellings of one host and path are one remote, while the path keeps its case.
 */
export function remoteIdentity(shown) {
  if (typeof shown !== "string" || !shown) return null;
  let host, tail;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(shown)) {
    try { const parsed = new URL(shown); host = parsed.hostname; tail = parsed.pathname; } catch { return null; }
  } else {
    const separator = shown.indexOf(":");
    if (separator <= 0) return null;
    host = shown.slice(0, separator);
    tail = shown.slice(separator + 1);
  }
  if (!host) return null;
  tail = tail.replace(/^\/+|\/+$/g, "");
  if (tail.endsWith(".git")) tail = tail.slice(0, -".git".length);
  return `${host.toLowerCase()}/${tail}`;
}

/** Whether two shown remotes are the same remote. */
export function sameRemote(left, right) {
  const identity = remoteIdentity(left);
  return identity !== null && identity === remoteIdentity(right);
}

// What the checkout can prove about itself: its shown remote, or null for no network remote, its root commit, and why history may not prove it.
async function checkoutFacts(root) {
  const [origin, shallow, head] = await Promise.all([
    git(root, ["config", "--get", "remote.origin.url"]),
    git(root, ["rev-parse", "--is-shallow-repository"]),
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])
  ]);
  return { remote: publicRemote(origin || null), root: await rootCommit(root, shallow), shallow: shallow === "true", commits: Boolean(head), folder: path.basename(root) };
}

const registrationFile = (base, name) => path.join(base, REPOSITORIES, `${name}.json`);

// The registrations folder, which must be a real folder of the store, never a link out of it, or null while it does not exist.
async function registrationsFolder(base, fail) {
  const folder = path.join(base, REPOSITORIES);
  let info;
  try { info = await lstat(folder); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw fail("store_unavailable", `The registrations folder ${REPOSITORIES} of the record store cannot be read (${error.code ?? error.message}).`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw fail("invalid_path", `The registration location ${REPOSITORIES} must be a folder inside the record store, not a symbolic link or a file.`);
  return folder;
}

// A registration's bytes, read without following a link and never past the size limit, or null when it is no regular file or is too large.
async function registrationBytes(target) {
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(REGISTRATION_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > REGISTRATION_MAX_BYTES ? null : buffer.subarray(0, length);
  } finally { await handle.close(); }
}

// Every registration in the store, in name order; a file Prism cannot read still holds its name and accepts no checkout.
async function readRegistrations(base, fail) {
  const folder = await registrationsFolder(base, fail);
  let names = [];
  if (folder) {
    try { names = (await readdir(folder)).filter((name) => name.endsWith(".json") && REPOSITORY_NAME.test(name.slice(0, -".json".length))).sort(); }
    catch (error) { throw fail("store_unavailable", `The registrations folder ${REPOSITORIES} of the record store cannot be read (${error.code ?? error.message}).`); }
  }
  const registrations = [];
  for (const file of names) {
    const name = file.slice(0, -".json".length);
    let parsed = null;
    try {
      const bytes = await registrationBytes(path.join(folder, file));
      if (bytes) parsed = JSON.parse(bytes.toString("utf8"));
    } catch { /* An unreadable registration keeps its name taken. */ }
    const valid = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.remotes);
    registrations.push(valid
      ? { name, remotes: parsed.remotes.filter((remote) => typeof remote === "string"), root: typeof parsed.root === "string" ? parsed.root : null, document: parsed }
      : { name, remotes: [], root: null, unreadable: true });
  }
  return registrations;
}

// The registration other than the named one that lists the checkout's remote, if any.
const remoteOwner = (registrations, facts, except) => facts.remote
  ? registrations.find((item) => item.name !== except && !item.unreadable && item.remotes.some((remote) => sameRemote(remote, facts.remote)))
  : undefined;

// How a registration accepts the checkout: by its remote, by having no network remote as the checkout has none, by its root commit while no other registration lists the checkout's remote, or not at all.
function acceptance(registration, facts, registrations) {
  if (registration.unreadable) return null;
  if (facts.remote ? registration.remotes.some((remote) => sameRemote(remote, facts.remote)) : registration.remotes.length === 0) return "remote";
  if (facts.root && registration.root === facts.root && !remoteOwner(registrations, facts, registration.name)) return "root";
  return null;
}

function lastSegment(shown) {
  const identity = remoteIdentity(shown);
  return identity === null ? "" : identity.slice(identity.indexOf("/") + 1).split("/").at(-1);
}

const trimName = (value) => value.replace(/^[-_]+|[-_]+$/g, "");

/** A name the store would accept for this checkout: a registration that accepts it, or one derived from its remote or folder that no other repository holds. */
function proposedName(registrations, facts) {
  const accepting = registrations.find((registration) => acceptance(registration, facts, registrations));
  if (accepting) return accepting.name;
  const source = (facts.remote && lastSegment(facts.remote)) || facts.folder;
  const base = trimName(trimName(source.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")).slice(0, NAME_MAX)) || "repository";
  const taken = new Set(registrations.map((registration) => registration.name));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${trimName(base.slice(0, NAME_MAX - `-${suffix}`.length))}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const line = (name) => `- Repository: ${name}`;
const shownRemotes = (remotes) => remotes.length ? remotes.join(", ") : "no network remote";

function refusal(fail, code, message, proposed) {
  return fail(code, message, { proposed });
}

// Why the checkout's history could not prove that it is the registered repository, or null when both root commits are known and differ.
function unproven(registration, facts) {
  if (facts.shallow) return "this checkout is a shallow clone, so its root commit is unknown";
  if (!facts.commits) return "this checkout has no commits yet";
  if (registration.root === null) return "the registration has no root commit to compare";
  return null;
}

const remoteRegistered = (fail, name, facts, other) => refusal(fail, "repository_remote_registered", `The remote ${facts.remote} of this checkout is registered in the record store as repository ${other.name}, so it cannot also be repository ${name}. Use \`${line(other.name)}\` under \`## Workspace\` in .prism/workflow.md.`, other.name);

/** Decide a named checkout against the registrations: { accept, write? } or { register }, or throw a refusal. */
function decide(name, registrations, facts, fail) {
  const registration = registrations.find((item) => item.name === name);
  if (!registration) {
    const other = remoteOwner(registrations, facts, name);
    if (other) throw remoteRegistered(fail, name, facts, other);
    return { register: { schemaVersion: 1, name, remotes: facts.remote ? [facts.remote] : [], root: facts.root, registeredAt: new Date().toISOString() } };
  }
  const how = acceptance(registration, facts, registrations);
  // A matching root commit never moves a remote that another name registered, as a fork's checkout naming the original would.
  const other = !how && !registration.unreadable && facts.root && registration.root === facts.root && remoteOwner(registrations, facts, name);
  if (other) throw remoteRegistered(fail, name, facts, other);
  if (how === "root" && facts.remote) return { accept: true, write: { ...registration.document, remotes: [...registration.remotes, facts.remote] } };
  if (how === "remote" && registration.root === null && facts.root) return { accept: true, write: { ...registration.document, root: facts.root } };
  if (how) return { accept: true };
  const proposed = proposedName(registrations, facts);
  const why = registration.unreadable ? "the registration file cannot be read" : unproven(registration, facts);
  throw refusal(fail, "repository_name_taken", [
    `The repository name ${name} is registered in the record store for ${registration.unreadable ? "a registration Prism cannot read" : shownRemotes(registration.remotes)}, but this checkout's remote is ${facts.remote ?? "no network remote"}`,
    why ? `, and its history cannot prove that it is the same repository because ${why}.` : ", and its root commit differs from the registered one.",
    ` If this is the same repository moved on its host, run \`git fetch --unshallow\` so its history can prove it; otherwise name the repository differently, such as \`${line(proposed)}\` under \`## Workspace\` in .prism/workflow.md.`
  ].join(""), proposed);
}

const serialize = (registration) => `${JSON.stringify(registration, null, 2)}\n`;

/**
 * Check a checkout's repository name against its record store before any record operation touches the store.
 * Resolves to { repository, created } for an accepted name, where created says this check wrote a new registration,
 * or to { repository: null, proposed } for a checkout that names no repository; refuses with fail(code, message, { proposed }).
 * beforeWrite runs before the first file this check writes, which only an accepted check does.
 */
export async function checkRepositoryName({ root, base, name, fail, beforeWrite = async () => {} }) {
  const facts = await checkoutFacts(root);
  // A proposal is advice, so registrations Prism cannot read leave it derived from the remote or folder alone rather than failing the operation.
  const proposal = async () => proposedName(await readRegistrations(base, fail).catch(() => []), facts);
  if (name === null || name === undefined) return { repository: null, proposed: await proposal() };
  if (!REPOSITORY_NAME.test(name)) {
    const proposed = await proposal();
    throw refusal(fail, "repository_name_invalid", `The repository name ${name} under \`## Workspace\` in .prism/workflow.md is invalid: a repository name must use lowercase letters, digits, hyphens, or underscores, starting and ending with a letter or digit, with at most ${NAME_MAX} characters. Use \`${line(proposed)}\`.`, proposed);
  }
  const first = decide(name, await readRegistrations(base, fail), facts, fail);
  if (first.accept && !first.write) return { repository: name, created: false };
  // A write happens under the store's registration lock against the registrations as they then stand, so two checkouts never both register one name.
  await beforeWrite();
  const lock = path.join(base, REPOSITORIES);
  if (!(await registrationsFolder(base, fail))) await mkdir(lock).catch((error) => { if (error.code !== "EEXIST") throw error; });
  return withArtifactLock(lock, () => withFileLock(lock, async () => {
    const decision = decide(name, await readRegistrations(base, fail), facts, fail);
    const contents = decision.register ?? decision.write;
    if (contents) await writeAtomically(registrationFile(base, name), serialize(contents));
    return { repository: name, created: Boolean(decision.register) };
  }, fail, { timeoutMs: 30000 }));
}
