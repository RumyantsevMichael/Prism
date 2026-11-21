// A local ACP registry for the registry tests: an HTTP server on 127.0.0.1 that serves an index in the public registry's shape
// and the archives it names, built from the fake agent, and stub npm and uv programs that log what Prism runs.
// The review server reads this registry through PRISM_ACP_REGISTRY_URL, so no test reaches the public registry.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { hiddenProgram } from "./no-host-path.mjs";

/** This computer's registry platform key, such as linux-x86_64, linux-x86_64-musl, or darwin-aarch64. */
export function platformKey() {
  const system = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  const musl = system === "linux" && !process.report?.getReport?.()?.header?.glibcVersionRuntime;
  return `${system}-${arch}${musl ? "-musl" : ""}`;
}

// The package programs whose presence decides whether an npx or uvx agent can be installed; no test process finds the hosts that
// Prism runs itself, the native dialog programs, or a well-known coding agent either.
const WITHHELD = new Set(["npm", "npx", "uv", "uvx"]);

/**
 * Gives the fixture a PATH of its stub folder and one folder of links to every other program of its PATH, without npm, npx, uv,
 * uvx, or any program that the test guard hides, so that what this computer has installed decides nothing; packageTools adds stub
 * npm and uv to the stub folder.
 */
async function withoutPackageTools(fixture) {
  const folder = path.join(path.dirname(fixture.log), "system-tools");
  await mkdir(folder, { recursive: true });
  const linked = new Set();
  for (const source of (fixture.env.PATH ?? "").split(path.delimiter).filter((entry) => entry && entry !== fixture.bin)) {
    let names = [];
    try { names = readdirSync(source); } catch { continue; }
    for (const name of names) {
      if (linked.has(name) || WITHHELD.has(name) || hiddenProgram(name)) continue;
      const target = path.join(source, name);
      try { if (!statSync(target).isFile()) continue; } catch { continue; }
      linked.add(name);
      await symlink(target, path.join(folder, name));
    }
  }
  fixture.env.PATH = [fixture.bin, folder].join(path.delimiter);
  process.env.PATH = fixture.env.PATH;
}
export const OTHER_PLATFORM = platformKey().startsWith("linux") ? "windows-x86_64" : "linux-x86_64";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** A .tar.gz of the given files, { name: { text, mode } }, built with the system tar. */
async function tarGz(files) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "prism-registry-tar-"));
  try {
    for (const [name, { text, mode = 0o644 }] of Object.entries(files)) {
      const file = path.join(folder, "content", name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      chmodSync(file, mode);
    }
    execFileSync("tar", ["-czf", path.join(folder, "out.tar.gz"), "-C", path.join(folder, "content"), ...Object.keys(files)]);
    return await readFile(path.join(folder, "out.tar.gz"));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** A .zip of the given files with deflated entries and Unix modes; a name may hold any path, such as ../escape. */
export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, { text, mode = 0o644 }] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const sum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(sum, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(sum, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The fake ACP agent of fixtures/acp-agents.mjs as an archive's program, which logs to FAKE_ACP_LOG under the agent name it is given. */
export const agentProgram = (fixture) => ({ text: `#!/bin/sh\nexec ${JSON.stringify(fixture.agent)} "$@"\n`, mode: 0o755 });

/**
 * Starts the registry server for a fixture of fixtures/acp-agents.mjs, points the review server at it, and gives the fixture the PATH
 * of withoutPackageTools.
 * setAgents(list) replaces the index's agents; addArchive(name, files, { kind }) serves an archive and answers its url and sha256;
 * requests() lists the paths that were fetched; down(status) makes every request answer that status, or close the connection for 0;
 * hold() keeps every archive response waiting until release().
 */
export async function registryFixture(context, fixture) {
  await withoutPackageTools(fixture);
  const archives = new Map();
  const fetched = [];
  let index = { version: "1.0.0", agents: [], extensions: [] };
  let failure = null;
  let holding = null;
  const server = http.createServer(async (request, response) => {
    fetched.push(request.url);
    if (failure === 0) { request.socket.destroy(); return; }
    if (failure) { response.writeHead(failure); response.end("down"); return; }
    if (request.url === "/registry.json") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(index)); return; }
    const archive = archives.get(request.url);
    if (!archive) { response.writeHead(404); response.end(); return; }
    if (holding) await holding.promise;
    response.writeHead(200);
    response.end(archive);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PRISM_ACP_REGISTRY_URL = `${base}/registry.json`;
  fixture.env.PRISM_ACP_REGISTRY_URL = process.env.PRISM_ACP_REGISTRY_URL;
  const addArchive = async (name, files, { kind = "tar.gz" } = {}) => {
    const bytes = kind === "zip" ? zip(files) : await tarGz(files);
    archives.set(`/${name}`, bytes);
    return { url: `${base}/${name}`, sha256: sha256(bytes) };
  };
  return {
    base,
    addArchive,
    setAgents: (agents) => { index = { ...index, agents }; },
    requests: () => [...fetched],
    down: (status) => { failure = status; },
    hold: () => { let release; holding = { promise: new Promise((resolve) => { release = resolve; }) }; holding.release = release; },
    release: () => { holding?.release(); holding = null; },
    up: () => { failure = null; }
  };
}

/** A binary registry entry for this platform whose archive holds the fake agent as ./agent. */
export async function binaryAgent(fixture, registry, { id, name = id, version = "1.0.0", license = "MIT", sha = true, platform = platformKey(), kind = "tar.gz", extra = {} } = {}) {
  const archive = await registry.addArchive(`${id}-${version}.${kind}`, { agent: agentProgram(fixture) }, { kind });
  return {
    id, name, version, description: `${name} for tests.`, repository: `https://example.invalid/${id}`, authors: ["Fake Authors"], license,
    distribution: { binary: { [platform]: { archive: archive.url, cmd: "./agent", args: [id], ...(sha ? { sha256: archive.sha256 } : {}) } } },
    ...extra
  };
}

/** Stub npm and uv programs on the fixture's PATH that log their arguments and lay out what a real install would. */
export async function packageTools(fixture, { npmVersion = null, tools = ["npm", "uv"] } = {}) {
  const log = path.join(path.dirname(fixture.log), "package-tools.jsonl");
  for (const tool of tools) {
    const file = path.join(fixture.bin, tool);
    await writeFile(file, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: ${JSON.stringify(tool)}, argv, cwd: process.cwd(), env: { npm_config_cache: process.env.npm_config_cache ?? null, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? null } }) + "\\n");
if (${JSON.stringify(tool)} === "npm" && argv.includes("--package-lock-only")) { fs.writeFileSync("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: {} })); }
if (${JSON.stringify(tool)} === "npm" && argv[0] === "ci") {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    const folder = path.join("node_modules", name);
    fs.mkdirSync(path.join(folder, "bin"), { recursive: true });
    fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({ name, version: ${JSON.stringify(npmVersion)} ?? version, bin: { agent: "bin/agent" } }));
    fs.writeFileSync(path.join(folder, "bin", "agent"), "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
  }
}
if (${JSON.stringify(tool)} === "uv" && argv.includes("compile")) { const out = argv[argv.indexOf("-o") + 1] ?? argv[argv.indexOf("--output-file") + 1]; if (out) fs.writeFileSync(out, "fake-agent-acp==0.10.1\\n"); }
process.exit(0);
`);
    chmodSync(file, 0o755);
  }
  return () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
}
