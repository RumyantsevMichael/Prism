import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rm, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { scheduleRecordSync, SYNC_DIRECTORY, syncRecordStoreNow } from "./record-store-sync.mjs";
import { publicRemote } from "./remote-url.mjs";

// A checkout names its repository to its record store, which registers each name with the remotes and root commit that prove which repository it is.
// The registrations live in a folder of their own at the store root, never under a .prism address, so no record path can collide with them.
export const REPOSITORIES = "repositories";
// No name holds "/", which a later increment uses in <repository>/<component>.
export const REPOSITORY_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const NAME_MAX = 64;
const REGISTRATION_MAX_BYTES = 64 * 1024;
// The refusals of a named checkout, which every record operation reports while the checkout stays refused.
export const REPOSITORY_REFUSALS = Object.freeze(["repository_name_invalid", "repository_remote_registered", "repository_name_taken", "repository_unconfirmed"]);
// The sync outcomes after which the store holds the registration that won, or holds it only locally because nothing else shares the store's remote.
const CONFIRMING = new Set(["ok", "conflicts", "no_upstream", "not_a_repository"]);

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
  // storeLayout marks the refusal as the store's own layout, so a view hides the records as for an unavailable store while a tool call still answers invalid_path.
  if (info.isSymbolicLink() || !info.isDirectory()) throw fail("invalid_path", `The registration location ${REPOSITORIES} must be a folder inside the record store, not a symbolic link or a file.`, { storeLayout: true });
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

// A new registration in a synced store stays pending until its confirming sync settles: a marker in the store's sync folder, which sync never commits, says so to every check that sees the store folder.
// The registering check renews its marker while the sync runs, and a marker that is no longer renewed, or whose process on this host has exited, has expired.
const PENDING_FOLDER = "registering";
const PENDING_RENEW_MS = 5000;
const PENDING_STALE_MS = 30000;
const pendingFolder = (base) => path.join(base, SYNC_DIRECTORY, PENDING_FOLDER);

// A marker's owner while it is live, or null once it has expired.
async function pendingOwner(target) {
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile() || Date.now() - info.mtimeMs > PENDING_STALE_MS) return null;
  // A marker still being written has no owner yet and counts as live until it is old.
  const owner = await readFile(target, "utf8").then((text) => JSON.parse(text) ?? {}).catch(() => ({}));
  // A process on another host cannot be asked, so only the marker's age expires it.
  if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return owner;
  try { process.kill(owner.pid, 0); return owner; } catch (error) { return error.code === "ESRCH" ? null : owner; }
}

// The tokens of the live pending registrations in the store, by name.
async function readPending(base, fail) {
  let files;
  try { files = await readdir(pendingFolder(base)); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return new Map();
    throw fail("store_unavailable", `The pending registrations in ${SYNC_DIRECTORY}/${PENDING_FOLDER} of the record store cannot be read (${error.code ?? error.message}).`);
  }
  const pending = new Map();
  for (const file of files) {
    const name = file.endsWith(".json") ? file.slice(0, -".json".length) : "";
    if (!REPOSITORY_NAME.test(name)) continue;
    const owner = await pendingOwner(path.join(pendingFolder(base), file));
    if (owner) pending.set(name, owner.token ?? null);
  }
  return pending;
}

/**
 * The registrations and the pending markers, read so that a registration seen settled was settled: a registering check writes its marker before its registration and removes it only after confirming or withdrawing that registration,
 * so registrations that read the same before and after the markers held no unconfirmed registration whose marker was missed.
 */
async function readView(base, fail) {
  let registrations = await readRegistrations(base, fail);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pending = await readPending(base, fail);
    const again = await readRegistrations(base, fail);
    if (JSON.stringify(again) === JSON.stringify(registrations)) return { registrations, pending };
    registrations = again;
  }
  return { registrations, pending: null };
}

const pendingRefusal = (fail, name) => fail("repository_unconfirmed", `The repository name ${name} cannot be checked yet, because a new registration that decides it is still being confirmed with the record store's remote (sync running), so this operation was not applied. Try again in a moment.`, { proposed: name, pending: true });

// What a decision is, so a decision with and without the pending registrations can be compared.
function outcome(name, registrations, facts, fail) {
  try {
    const decision = decide(name, registrations, facts, fail);
    return { decision, kind: decision.register ? "register" : decision.write ? "write" : "accept" };
  } catch (error) { return { error, kind: error.code }; }
}

/** Decide against the registrations as they stand, unless a pending registration other than the caller's own would change the decision; then refuse with repository_unconfirmed. */
function decideSettled(name, view, facts, fail, own = null) {
  if (view.pending === null) throw pendingRefusal(fail, name);
  const others = new Set([...view.pending].filter(([, token]) => own === null || token !== own).map(([pendingName]) => pendingName));
  const stands = outcome(name, view.registrations, facts, fail);
  if (others.size && outcome(name, view.registrations.filter((item) => !others.has(item.name)), facts, fail).kind !== stands.kind) throw pendingRefusal(fail, name);
  if (stands.error) throw stands.error;
  return stands.decision;
}

// Mark a registration pending before it is written, and renew the mark until release removes it; release leaves a mark another check has since replaced.
async function markPending(base, name) {
  await mkdir(pendingFolder(base), { recursive: true });
  const target = path.join(pendingFolder(base), `${name}.json`);
  const token = randomBytes(16).toString("hex");
  await writeAtomically(target, `${JSON.stringify({ pid: process.pid, host: hostname(), token, at: new Date().toISOString() })}\n`);
  const heartbeat = setInterval(() => { const now = new Date(); utimes(target, now, now).catch(() => {}); }, PENDING_RENEW_MS);
  heartbeat.unref();
  return {
    token,
    release: async () => {
      clearInterval(heartbeat);
      const owner = await readFile(target, "utf8").then(JSON.parse).catch(() => null);
      if (owner?.token === token) await rm(target, { force: true }).catch(() => {});
    }
  };
}

// Run an action under the store's registration lock, so two checkouts never both register one name; no check holds it across a sync.
async function withRegistrationLock(base, fail, action) {
  const lock = path.join(base, REPOSITORIES);
  if (!(await registrationsFolder(base, fail))) await mkdir(lock).catch((error) => { if (error.code !== "EEXIST") throw error; });
  return withArtifactLock(lock, () => withFileLock(lock, action, fail, { timeoutMs: 30000 }));
}

// Remove the registration this check wrote, if the file still holds its bytes.
async function withdraw(base, name, contents) {
  const target = registrationFile(base, name);
  const bytes = await registrationBytes(target).catch(() => null);
  if (bytes?.equals(Buffer.from(serialize(contents)))) await rm(target, { force: true });
}

const unconfirmed = (fail, name, status) => {
  const reason = String(status.message ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return refusal(fail, "repository_unconfirmed", `The registration of the repository name ${name} could not be confirmed with the record store's remote (${status.state}${reason ? `: ${reason}` : ""}), so it was withdrawn and this operation was not applied. Try again once the remote is reachable.`, name);
};

/**
 * Confirm a new pending registration with the store's remote: a sync of its own, holding no lock, then the check again under the registration lock against the registration the store then holds,
 * so another machine's registration that won accepts or refuses this checkout; a sync that cannot confirm, or throws, withdraws the registration and refuses. The pending mark goes last.
 */
async function confirmRegistration(base, name, facts, fail, contents, mark) {
  try {
    let status;
    try { status = await syncRecordStoreNow(base); }
    catch (error) { status = { state: "sync_failed", message: error?.message }; }
    if (!CONFIRMING.has(status.state)) {
      // A withdrawal is safe without the lock, because no other check writes a name while its registration is pending, so a lock that cannot be taken never keeps the registration.
      await withRegistrationLock(base, fail, () => withdraw(base, name, contents)).catch(() => withdraw(base, name, contents)).catch(() => {});
      throw unconfirmed(fail, name, status);
    }
    // An addition, or a registration written again because the store lost it, is written without confirmation and synced later.
    await withRegistrationLock(base, fail, async () => {
      const decision = decideSettled(name, await readView(base, fail), facts, fail, mark.token);
      const again = decision.register ?? decision.write ?? null;
      if (again) {
        await writeAtomically(registrationFile(base, name), serialize(again));
        scheduleRecordSync(base);
      }
    });
    return { repository: name, created: true };
  } finally { await mark.release(); }
}

/**
 * Check a checkout's repository name against its record store before any record operation touches the store.
 * Resolves to { repository, created } for an accepted name, where created says this check wrote a new registration,
 * or to { repository: null, proposed } for a checkout that names no repository; refuses with fail(code, message, { proposed }).
 * beforeWrite runs before the first file this check writes, which only an accepted check does.
 * A decision that a pending registration would change refuses with repository_unconfirmed and pending: true, whatever the checkout's own sync setting.
 * In a synced store, a new registration is pending until a sync confirms it before the check accepts, and a remote or root added to a registration is synced later.
 */
export async function checkRepositoryName({ root, base, name, fail, beforeWrite = async () => {}, sync = false }) {
  const facts = await checkoutFacts(root);
  // A proposal is advice, so registrations Prism cannot read leave it derived from the remote or folder alone rather than failing the operation.
  const proposal = async () => proposedName(await readRegistrations(base, fail).catch(() => []), facts);
  if (name === null || name === undefined) return { repository: null, proposed: await proposal() };
  if (!REPOSITORY_NAME.test(name)) {
    const proposed = await proposal();
    throw refusal(fail, "repository_name_invalid", `The repository name ${name} under \`## Workspace\` in .prism/workflow.md is invalid: a repository name must use lowercase letters, digits, hyphens, or underscores, starting and ending with a letter or digit, with at most ${NAME_MAX} characters. Use \`${line(proposed)}\`.`, proposed);
  }
  // A registration that accepts as it stands, and is not pending, needs no lock.
  const first = decideSettled(name, await readView(base, fail), facts, fail);
  if (first.accept && !first.write) return { repository: name, created: false };
  await beforeWrite();
  // The decision is made again under the lock, and a new registration in a synced store is marked pending before it is written and confirmed after the lock is released.
  const written = await withRegistrationLock(base, fail, async () => {
    const decision = decideSettled(name, await readView(base, fail), facts, fail);
    const contents = decision.register ?? decision.write ?? null;
    if (!contents) return { decision };
    let mark = null;
    if (sync && decision.register) {
      try { mark = await markPending(base, name); }
      catch (error) { throw unconfirmed(fail, name, { state: "sync_failed", message: error?.message }); }
    }
    try { await writeAtomically(registrationFile(base, name), serialize(contents)); }
    catch (error) { await mark?.release(); throw error; }
    if (sync && !mark) scheduleRecordSync(base);
    return { decision, contents, mark };
  });
  if (written.mark) return confirmRegistration(base, name, facts, fail, written.contents, written.mark);
  return { repository: name, created: Boolean(written.decision.register) };
}
