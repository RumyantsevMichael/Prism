import assert from "node:assert/strict";
import * as fileSystem from "node:fs/promises";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPrivateSessionStore } from "../../dist/server/session/private-session-store.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const unsafePathCode = "UNSAFE_EXAMPLE_PATH";
const staleTime = new Date("2000-01-01T00:00:00.000Z");

async function temporaryDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function exampleStore(lockProtocol, maxLockOwnerBytes = 128) {
  return createPrivateSessionStore({
    directoryName: "example-store",
    subject: "example",
    unsafePathCode,
    lockProtocol,
    maxLockOwnerBytes
  });
}

async function resolvedStore(context, lockProtocol, maxLockOwnerBytes) {
  const dataDirectory = await temporaryDirectory(context, `prism-private-store-${lockProtocol}-`);
  const store = exampleStore(lockProtocol, maxLockOwnerBytes);
  const location = await store.resolveDirectory(dataDirectory, { create: true, fileSystem });
  return { store, location, dataDirectory };
}

function isUnsafe(error) {
  return error?.code === unsafePathCode;
}

const sharedSafetyNames = [
  "noFollowFlags",
  "isDirectChild",
  "assertDirectChild",
  "inspectRegularFile",
  "openExistingRegularFile",
  "openPrivateFile",
  "wait",
  "lockOwnerName",
  "lockOwnerText",
  "createOwnedLock",
  "inspectLockPath",
  "readLockOwner",
  "ownsLock",
  "assertOwnedLock",
  "acquireLock",
  "removeOwnedLock",
  "removeOwnedLockArtifact",
  "removeEmptyLockArtifact",
  "cleanupAbandonedLockArtifacts",
  "releaseOwnedLock",
  "defaultIsProcessAlive",
  "processState",
  "LOCK_RETRY_COUNT",
  "LOCK_STALE_MS",
  "MAX_LOCK_OWNER_BYTES",
  "LOCK_DIRECTORY_NAME",
  "LOCK_OWNER_PREFIX",
  "LOCK_OWNER_PATTERN",
  "PENDING_LOCK_PATTERN",
  "STALE_LOCK_PATTERN",
  "RELEASE_LOCK_PATTERN"
];

for (const [storeFile, retiredCopies] of [
  ["src/server/session/session-trace-store.mjs", ["resolveTraceDirectory", "assertTraceDirectory", "UnsafeSessionTracePathError"]],
  ["src/server/session/host-session-facts.mjs", ["resolveFactDirectory", "assertFactDirectory", "UnsafeHostFactPathError"]]
]) {
  test(`${path.basename(storeFile)} uses the shared store safety unit instead of a private copy`, async () => {
    const source = await readFile(path.join(repositoryRoot, storeFile), "utf8");
    assert.match(source, /from "\.\/private-session-store\.mjs"/);
    assert.match(source, /createPrivateSessionStore\(/);
    for (const name of [...retiredCopies, ...sharedSafetyNames]) {
      assert.doesNotMatch(
        source,
        new RegExp(`\\b(?:function\\*?|class|const|let|var)\\s+${name}\\b`),
        `${storeFile} still declares ${name}`
      );
    }
    for (const literal of ["fileConstants", "O_NOFOLLOW", "O_EXCL", "O_DIRECTORY", ".retention.lock", "owner-"]) {
      assert.equal(source.includes(literal), false, `${storeFile} still uses ${literal}`);
    }
  });
}

test("resolves a private store directory and rejects a symbolic-link directory", async (context) => {
  const { store, location, dataDirectory } = await resolvedStore(context, "direct");
  assert.equal(path.basename(location.directory), "example-store");
  assert.equal((await stat(location.directory)).mode & 0o777, 0o700);
  await store.assertDirectory(location, fileSystem);

  const linkedData = await temporaryDirectory(context, "prism-private-store-linked-");
  await symlink(dataDirectory, path.join(linkedData, "example-store"), "dir");
  await assert.rejects(store.resolveDirectory(linkedData, { create: false, fileSystem }), isUnsafe);
});

test("rejects paths that are not direct children of the store directory", async (context) => {
  const { store, location } = await resolvedStore(context, "direct");
  assert.throws(() => store.assertDirectChild(location.directory, path.join(location.directory, "a", "b"), "The path"), isUnsafe);
  assert.throws(() => store.assertDirectChild(location.directory, path.dirname(location.directory), "The path"), isUnsafe);
  store.assertDirectChild(location.directory, path.join(location.directory, "record.json"), "The path");
});

test("rejects symbolic-link and hard-linked records and opens regular records without following links", async (context) => {
  const { store, location } = await resolvedStore(context, "direct");
  const outside = await temporaryDirectory(context, "prism-private-store-outside-");
  const outsidePath = path.join(outside, "outside.json");
  await writeFile(outsidePath, "outside\n", { mode: 0o600 });

  const symbolicPath = path.join(location.directory, "symbolic.json");
  await symlink(outsidePath, symbolicPath, "file");
  await assert.rejects(store.inspectRegularFile(symbolicPath, location.directory, fileSystem), isUnsafe);

  const hardPath = path.join(location.directory, "hard.json");
  await link(outsidePath, hardPath);
  await assert.rejects(store.openExistingRegularFile(hardPath, location.directory, fileSystem), isUnsafe);

  const missingPath = path.join(location.directory, "missing.json");
  assert.equal(await store.openExistingRegularFile(missingPath, location.directory, fileSystem, { missing: true }), null);

  const regularPath = path.join(location.directory, "regular.json");
  const handle = await store.openPrivateFile(regularPath, fileSystem);
  await handle.writeFile("record\n", "utf8");
  await handle.close();
  assert.equal((await stat(regularPath)).mode & 0o777, 0o600);
  await assert.rejects(store.openPrivateFile(regularPath, fileSystem), (error) => error.code === "EEXIST");

  const opened = await store.openExistingRegularFile(regularPath, location.directory, fileSystem);
  try {
    assert.equal(await opened.handle.readFile("utf8"), "record\n");
  } finally {
    await opened.handle.close();
  }
  assert.equal(await readFile(outsidePath, "utf8"), "outside\n");
});

for (const lockProtocol of ["direct", "staged"]) {
  test(`${lockProtocol} lock publication acquires, checks, and releases one owner`, async (context) => {
    const { store, location } = await resolvedStore(context, lockProtocol);
    const lockPath = path.join(location.directory, ".retention.lock");
    const lock = await store.acquireLock(location.directory, fileSystem, () => true);
    assert.notEqual(lock, null);
    assert.equal(lock.lockPath, lockPath);
    const [ownerName] = await readdir(lockPath);
    assert.equal(ownerName, `owner-${lock.token}`);
    assert.equal((await stat(path.join(lockPath, ownerName))).mode & 0o777, 0o600);
    assert.equal(await store.ownsLock(lock, location.directory, fileSystem), true);

    assert.equal(await store.acquireLock(location.directory, fileSystem, () => true), null);

    assert.equal(await store.releaseLock(lock, location.directory, fileSystem), true);
    assert.equal(await store.ownsLock(lock, location.directory, fileSystem), false);
    assert.deepEqual((await readdir(location.directory)).filter((name) => name.startsWith(".retention.lock")), []);
  });

  test(`${lockProtocol} lock publication reclaims an aged lock only from a dead owner`, async (context) => {
    const { store, location } = await resolvedStore(context, lockProtocol);
    const lockPath = path.join(location.directory, ".retention.lock");
    const token = "22222222-2222-4222-8222-222222222222";
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(path.join(lockPath, `owner-${token}`), `${JSON.stringify({ token, pid: 424242 })}\n`, { mode: 0o600 });
    await utimes(lockPath, staleTime, staleTime);

    assert.equal(await store.acquireLock(location.directory, fileSystem, () => null), null);
    assert.deepEqual(await readdir(lockPath), [`owner-${token}`]);

    const lock = await store.acquireLock(location.directory, fileSystem, () => false);
    assert.notEqual(lock, null);
    assert.notEqual(lock.token, token);
    await store.releaseLock(lock, location.directory, fileSystem);
  });
}

test("direct lock publication reports an invalid aged owner as an unsafe path", async (context) => {
  const { store, location } = await resolvedStore(context, "direct");
  const lockPath = path.join(location.directory, ".retention.lock");
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(path.join(lockPath, "owner-invalid"), "{}\n", { mode: 0o600 });
  await utimes(lockPath, staleTime, staleTime);

  await assert.rejects(store.acquireLock(location.directory, fileSystem, () => false), isUnsafe);
  assert.deepEqual(await readdir(lockPath), ["owner-invalid"]);
});

test("staged lock publication treats an invalid aged owner as a busy lock", async (context) => {
  const { store, location } = await resolvedStore(context, "staged");
  const lockPath = path.join(location.directory, ".retention.lock");
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(path.join(lockPath, "owner-invalid"), "{}\n", { mode: 0o600 });
  await utimes(lockPath, staleTime, staleTime);

  assert.equal(await store.acquireLock(location.directory, fileSystem, () => false), null);
  assert.deepEqual(await readdir(lockPath), ["owner-invalid"]);
  assert.equal((await lstat(lockPath)).isDirectory(), true);
});

test("each store keeps its own lock owner size limit", async (context) => {
  const token = "44444444-4444-4444-8444-444444444444";
  const padded = `${JSON.stringify({ token, pid: 424242 })}${" ".repeat(180)}\n`;
  assert.equal(Buffer.byteLength(padded) > 128 && Buffer.byteLength(padded) <= 256, true);
  for (const [lockProtocol, maxLockOwnerBytes, accepted] of [
    ["direct", 256, true],
    ["direct", 128, false],
    ["staged", 128, false]
  ]) {
    const { store, location } = await resolvedStore(context, lockProtocol, maxLockOwnerBytes);
    const lockPath = path.join(location.directory, ".retention.lock");
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(path.join(lockPath, `owner-${token}`), padded, { mode: 0o600 });
    await utimes(lockPath, staleTime, staleTime);

    if (accepted) {
      const lock = await store.acquireLock(location.directory, fileSystem, () => false);
      assert.notEqual(lock, null);
      await store.releaseLock(lock, location.directory, fileSystem);
    } else if (lockProtocol === "direct") {
      await assert.rejects(store.acquireLock(location.directory, fileSystem, () => false), isUnsafe);
      assert.equal(await readFile(path.join(lockPath, `owner-${token}`), "utf8"), padded);
    } else {
      assert.equal(await store.acquireLock(location.directory, fileSystem, () => false), null);
      assert.equal(await readFile(path.join(lockPath, `owner-${token}`), "utf8"), padded);
    }
  }
});
