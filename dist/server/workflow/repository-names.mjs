// Generated from src/server/workflow/repository-names.mts by scripts/native-build/compile.mjs.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rm, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { windowsDeviceName } from "./artifact-paths.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { recordCheckout } from "./machine-checkouts.mjs";
import { scheduleRecordSync, SYNC_DIRECTORY, syncRecordStoreNow } from "./record-store-sync.mjs";
import { nestedDeeperThan } from "./record-merge.mjs";
import { publicRemote } from "./remote-url.mjs";
import { parseStoreJson } from "./store-json.mjs";
const REPOSITORIES = "repositories";
const REPOSITORY_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const NAME_MAX = 64;
const portableRepositoryName = (name) => typeof name === "string" && REPOSITORY_NAME.test(name) && !windowsDeviceName(name);
const REGISTRATION_MAX_BYTES = 64 * 1024;
const REPOSITORY_REFUSALS = Object.freeze(["repository_name_missing", "repository_name_invalid", "repository_remote_registered", "repository_name_taken", "repository_unconfirmed"]);
const CONFIRMING = /* @__PURE__ */ new Set(["ok", "conflicts", "no_upstream", "not_a_repository"]);
const git = (root, args) => new Promise((resolve) => {
  execFile("git", ["-C", root, ...args], { timeout: 1e4, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.trim()));
});
const repositoryIds = /* @__PURE__ */ new Map();
async function rootCommit(root, shallow) {
  if (repositoryIds.has(root)) return repositoryIds.get(root);
  if (shallow !== "false") return null;
  const id = (await git(root, ["rev-list", "--max-parents=0", "HEAD"]) ?? "").split(/\s+/).filter(Boolean).sort()[0] || null;
  if (id) repositoryIds.set(root, id);
  return id;
}
async function repositoryId(root) {
  if (repositoryIds.has(root)) return repositoryIds.get(root);
  return rootCommit(root, await git(root, ["rev-parse", "--is-shallow-repository"]));
}
function remoteIdentity(shown) {
  if (typeof shown !== "string" || !shown) return null;
  let host, tail;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(shown)) {
    try {
      const parsed = new URL(shown);
      host = parsed.hostname;
      tail = parsed.pathname;
    } catch {
      return null;
    }
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
function sameRemote(left, right) {
  const identity = remoteIdentity(left);
  return identity !== null && identity === remoteIdentity(right);
}
async function checkoutFacts(root) {
  const [origin, shallow, head] = await Promise.all([
    git(root, ["config", "--get", "remote.origin.url"]),
    git(root, ["rev-parse", "--is-shallow-repository"]),
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])
  ]);
  return { remote: publicRemote(origin || null), root: await rootCommit(root, shallow), shallow: shallow === "true", commits: Boolean(head), folder: path.basename(root) };
}
const registrationFile = (base, name) => path.join(base, REPOSITORIES, `${name}.json`);
async function registrationsFolder(base, fail) {
  const folder = path.join(base, REPOSITORIES);
  let info;
  try {
    info = await lstat(folder);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw fail("store_unavailable", `The registrations folder ${REPOSITORIES} of the record store cannot be read (${error.code ?? error.message}).`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw fail("invalid_path", `The registration location ${REPOSITORIES} must be a folder inside the record store, not a symbolic link or a file.`, { storeLayout: true });
  return folder;
}
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
  } finally {
    await handle.close();
  }
}
async function readRegistrations(base, fail) {
  const folder = await registrationsFolder(base, fail);
  let names = [];
  if (folder) {
    try {
      names = (await readdir(folder)).filter((name) => name.endsWith(".json") && REPOSITORY_NAME.test(name.slice(0, -".json".length))).sort();
    } catch (error) {
      throw fail("store_unavailable", `The registrations folder ${REPOSITORIES} of the record store cannot be read (${error.code ?? error.message}).`);
    }
  }
  const registrations = [];
  for (const file of names) {
    const name = file.slice(0, -".json".length);
    if (!portableRepositoryName(name)) {
      registrations.push({ name, remotes: [], root: null, unreadable: true });
      continue;
    }
    let parsed = null;
    try {
      const bytes = await registrationBytes(path.join(folder, file));
      if (bytes) parsed = parseStoreJson(bytes.toString("utf8"));
    } catch {
    }
    const valid = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.remotes) && !nestedDeeperThan(parsed);
    registrations.push(valid ? { name, remotes: parsed.remotes.filter((remote) => typeof remote === "string"), root: typeof parsed.root === "string" ? parsed.root : null, document: parsed } : { name, remotes: [], root: null, unreadable: true });
  }
  return registrations;
}
const remoteOwner = (registrations, facts, except) => facts.remote ? registrations.find((item) => item.name !== except && !item.unreadable && item.remotes.some((remote) => sameRemote(remote, facts.remote))) : void 0;
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
function proposedName(registrations, facts) {
  const accepting = registrations.find((registration) => acceptance(registration, facts, registrations));
  if (accepting) return accepting.name;
  const source = facts.remote && lastSegment(facts.remote) || facts.folder;
  const derived = trimName(trimName(source.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")).slice(0, NAME_MAX)) || "repository";
  const base = windowsDeviceName(derived) ? `${derived}-repository` : derived;
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
function unproven(registration, facts) {
  if (facts.shallow) return "this checkout is a shallow clone, so its root commit is unknown";
  if (!facts.commits) return "this checkout has no commits yet";
  if (registration.root === null) return "the registration has no root commit to compare";
  return null;
}
const remoteRegistered = (fail, name, facts, other) => refusal(fail, "repository_remote_registered", `The remote ${facts.remote} of this checkout is registered in the record store as repository ${other.name}, so it cannot also be repository ${name}. Use \`${line(other.name)}\` under \`## Workspace\` in .prism/workflow.md.`, other.name);
function decide(name, registrations, facts, fail) {
  const registration = registrations.find((item) => item.name === name);
  if (!registration) {
    const other2 = remoteOwner(registrations, facts, name);
    if (other2) throw remoteRegistered(fail, name, facts, other2);
    return { register: { schemaVersion: 1, name, remotes: facts.remote ? [facts.remote] : [], root: facts.root, registeredAt: (/* @__PURE__ */ new Date()).toISOString() } };
  }
  const how = acceptance(registration, facts, registrations);
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
const serialize = (registration) => `${JSON.stringify(registration, null, 2)}
`;
const PENDING_FOLDER = "registering";
const PENDING_RENEW_MS = 5e3;
const PENDING_STALE_MS = 3e4;
const pendingFolder = (base) => path.join(base, SYNC_DIRECTORY, PENDING_FOLDER);
async function pendingOwner(target) {
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile() || Date.now() - info.mtimeMs > PENDING_STALE_MS) return null;
  const owner = await readFile(target, "utf8").then((text) => parseStoreJson(text) ?? {}).catch(() => ({}));
  if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return owner;
  try {
    process.kill(owner.pid, 0);
    return owner;
  } catch (error) {
    return error.code === "ESRCH" ? null : owner;
  }
}
async function readPending(base, fail) {
  let files;
  try {
    files = await readdir(pendingFolder(base));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return /* @__PURE__ */ new Map();
    throw fail("store_unavailable", `The pending registrations in ${SYNC_DIRECTORY}/${PENDING_FOLDER} of the record store cannot be read (${error.code ?? error.message}).`);
  }
  const pending = /* @__PURE__ */ new Map();
  for (const file of files) {
    const name = file.endsWith(".json") ? file.slice(0, -".json".length) : "";
    if (!REPOSITORY_NAME.test(name)) continue;
    const owner = await pendingOwner(path.join(pendingFolder(base), file));
    if (owner) pending.set(name, owner.token ?? null);
  }
  return pending;
}
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
function outcome(name, registrations, facts, fail) {
  try {
    const decision = decide(name, registrations, facts, fail);
    return { decision, kind: decision.register ? "register" : decision.write ? "write" : "accept" };
  } catch (error) {
    return { error, kind: error.code };
  }
}
function decideSettled(name, view, facts, fail, own = null) {
  if (view.pending === null) throw pendingRefusal(fail, name);
  const others = new Set([...view.pending].filter(([, token]) => own === null || token !== own).map(([pendingName]) => pendingName));
  const stands = outcome(name, view.registrations, facts, fail);
  if (others.size && outcome(name, view.registrations.filter((item) => !others.has(item.name)), facts, fail).kind !== stands.kind) throw pendingRefusal(fail, name);
  if (stands.error) throw stands.error;
  return stands.decision;
}
async function markPending(base, name) {
  await mkdir(pendingFolder(base), { recursive: true });
  const target = path.join(pendingFolder(base), `${name}.json`);
  const token = randomBytes(16).toString("hex");
  await writeAtomically(target, `${JSON.stringify({ pid: process.pid, host: hostname(), token, at: (/* @__PURE__ */ new Date()).toISOString() })}
`);
  const heartbeat = setInterval(() => {
    const now = /* @__PURE__ */ new Date();
    utimes(target, now, now).catch(() => {
    });
  }, PENDING_RENEW_MS);
  heartbeat.unref();
  return {
    token,
    release: async () => {
      clearInterval(heartbeat);
      const owner = await readFile(target, "utf8").then(parseStoreJson).catch(() => null);
      if (owner?.token === token) await rm(target, { force: true }).catch(() => {
      });
    }
  };
}
async function withRegistrationLock(base, fail, action) {
  const lock = path.join(base, REPOSITORIES);
  if (!await registrationsFolder(base, fail)) await mkdir(lock).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return withArtifactLock(lock, () => withFileLock(lock, action, fail, { timeoutMs: 3e4 }));
}
async function withdraw(base, name, contents) {
  const target = registrationFile(base, name);
  const bytes = await registrationBytes(target).catch(() => null);
  if (bytes?.equals(Buffer.from(serialize(contents)))) await rm(target, { force: true });
}
const unconfirmed = (fail, name, status) => {
  const reason = String(status.message ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return refusal(fail, "repository_unconfirmed", `The registration of the repository name ${name} could not be confirmed with the record store's remote (${status.state}${reason ? `: ${reason}` : ""}), so it was withdrawn and this operation was not applied. Try again once the remote is reachable.`, name);
};
async function confirmRegistration(base, name, facts, fail, contents, mark) {
  try {
    let status;
    try {
      status = await syncRecordStoreNow(base);
    } catch (error) {
      status = { state: "sync_failed", message: error?.message };
    }
    if (!CONFIRMING.has(status.state)) {
      await withRegistrationLock(base, fail, () => withdraw(base, name, contents)).catch(() => withdraw(base, name, contents)).catch(() => {
      });
      throw unconfirmed(fail, name, status);
    }
    await withRegistrationLock(base, fail, async () => {
      const decision = decideSettled(name, await readView(base, fail), facts, fail, mark.token);
      const again = decision.register ?? decision.write ?? null;
      if (again) {
        await writeAtomically(registrationFile(base, name), serialize(again));
        scheduleRecordSync(base);
      }
    });
    return { repository: name, created: true };
  } finally {
    await mark.release();
  }
}
async function checkRepositoryName(options) {
  const checked = await checkName(options);
  if (checked.repository) await recordAccepted(options.root, options.base, checked.repository);
  return checked;
}
const RECORD_WAIT_MS = 3e3;
const recordedCheckouts = /* @__PURE__ */ new Set();
async function recordAccepted(root, base, name) {
  const key = `${root}\0${base}\0${name}`;
  if (recordedCheckouts.has(key)) return;
  recordedCheckouts.add(key);
  const recording = recordCheckout({ store: base, repository: name, path: root }).catch(() => {
  });
  let timer;
  await Promise.race([recording, new Promise((resolve) => {
    timer = setTimeout(resolve, RECORD_WAIT_MS);
    timer.unref();
  })]);
  clearTimeout(timer);
}
async function checkName({ root, base, name, fail, beforeWrite = async () => {
}, sync = false }) {
  const facts = await checkoutFacts(root);
  const proposal = async () => proposedName(await readRegistrations(base, fail).catch(() => []), facts);
  if (name === null || name === void 0) {
    const proposed = await proposal();
    throw refusal(fail, "repository_name_missing", `This checkout names a record store under \`## Workspace\` in .prism/workflow.md but no repository name, so Prism refuses its record operations and writes nothing to the store. Add \`${line(proposed)}\` under \`## Workspace\` in .prism/workflow.md and commit it.`, proposed);
  }
  if (!portableRepositoryName(name)) {
    const proposed = await proposal();
    throw refusal(fail, "repository_name_invalid", `The repository name ${name} under \`## Workspace\` in .prism/workflow.md is invalid: a repository name must use lowercase letters, digits, hyphens, or underscores, starting and ending with a letter or digit, with at most ${NAME_MAX} characters, and must be no Windows device name, which is con, prn, aux, nul, com0 to com9, or lpt0 to lpt9, because it names folders in the record store that every machine checks out. Use \`${line(proposed)}\`.`, proposed);
  }
  const first = decideSettled(name, await readView(base, fail), facts, fail);
  if (first.accept && !first.write) return { repository: name, created: false };
  await beforeWrite();
  const written = await withRegistrationLock(base, fail, async () => {
    const decision = decideSettled(name, await readView(base, fail), facts, fail);
    const contents = decision.register ?? decision.write ?? null;
    if (!contents) return { decision };
    let mark = null;
    if (sync && decision.register) {
      try {
        mark = await markPending(base, name);
      } catch (error) {
        throw unconfirmed(fail, name, { state: "sync_failed", message: error?.message });
      }
    }
    try {
      await writeAtomically(registrationFile(base, name), serialize(contents));
    } catch (error) {
      await mark?.release();
      throw error;
    }
    if (sync && !mark) scheduleRecordSync(base);
    return { decision, contents, mark };
  });
  if (written.mark) return confirmRegistration(base, name, facts, fail, written.contents, written.mark);
  return { repository: name, created: Boolean(written.decision.register) };
}
export {
  REPOSITORIES,
  REPOSITORY_NAME,
  REPOSITORY_REFUSALS,
  checkRepositoryName,
  portableRepositoryName,
  remoteIdentity,
  repositoryId,
  sameRemote
};
