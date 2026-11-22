// Tools for the install tests that the registry fixture does not offer: a stub uv that behaves as uv does for the commands an
// install runs, and archives with links, served as raw bytes from a local server.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * A stub uv in the fixture's stub folder, replacing any earlier one, that logs each run's arguments, folder, and uv environment.
 * `pip compile <in> -o <out>` locks each requirement of <in> as written, followed by a hash line, or writes `lock` in its place;
 * `venv <folder>` lays out <folder>/bin/python; `pip sync <requirements> --python <python>` lays out, beside that python, a program
 * named after each locked package, unless `programs` is false. Answers a function that reads the log.
 */
export async function uvTool(fixture, { lock = null, programs = true } = {}) {
  const log = path.join(path.dirname(fixture.log), "uv-runs.jsonl");
  const file = path.join(fixture.bin, "uv");
  await writeFile(file, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const watched = ["UV_CACHE_DIR", "UV_PYTHON_DOWNLOADS", "UV_NO_BUILD", "UV_PYTHON_INSTALL_DIR"];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: "uv", argv, cwd: process.cwd(), env: Object.fromEntries(watched.map((name) => [name, process.env[name] ?? null])) }) + "\\n");
const after = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
if (argv[0] === "pip" && argv[1] === "compile") {
  const lines = fs.readFileSync(argv[2], "utf8").split("\\n").map((line) => line.trim()).filter(Boolean);
  const locked = ${JSON.stringify(lock)} ?? lines.map((line) => line + " \\\\\\n    --hash=sha256:" + "0".repeat(64)).join("\\n");
  fs.writeFileSync(after("-o") ?? after("--output-file"), locked + "\\n");
} else if (argv[0] === "venv") {
  fs.mkdirSync(path.join(argv[1], "bin"), { recursive: true });
  fs.writeFileSync(path.join(argv[1], "bin", "python"), "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
} else if (argv[0] === "pip" && argv[1] === "sync" && ${JSON.stringify(programs)}) {
  const bin = path.dirname(after("--python") ?? after("-p"));
  for (const line of fs.readFileSync(argv[2], "utf8").split("\\n")) {
    const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)==/.exec(line.trim())?.[1];
    if (name) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
  }
}
process.exit(0);
`);
  chmodSync(file, 0o755);
  return () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
}

/** Serves bytes at a loopback URL until the test ends, and answers { url, sha256 }. */
export async function serveBytes(context, name, bytes) {
  const server = http.createServer((request, response) => {
    if (request.url !== `/${name}`) { response.writeHead(404); response.end(); return; }
    response.writeHead(200);
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/${name}`, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * A .tar.gz, built with the system tar, that holds the program `agent` and an `install.json` link that stays inside the folder it is
 * extracted to when read lexically but leads to `escaped` when followed: a chain of 60 folders ends in a link `l` back to the top,
 * so the 61 `..` after `l` climb from the top to the root, wherever the archive is extracted, and the target need not exist.
 */
export async function escapingLinkArchive(agentText, escaped) {
  const work = await mkdtemp(path.join(os.tmpdir(), "prism-link-archive-"));
  try {
    const content = path.join(work, "content");
    const chain = Array.from({ length: 60 }, (_, index) => `d${index}`);
    await mkdir(path.join(content, ...chain), { recursive: true });
    await symlink(chain.map(() => "..").join("/"), path.join(content, ...chain, "l"));
    const target = [...chain, "l", ...Array(chain.length + 1).fill(".."), ...escaped.split(path.sep).filter(Boolean)].join("/");
    await symlink(target, path.join(content, "install.json"));
    await writeFile(path.join(content, "agent"), agentText, { mode: 0o755 });
    execFileSync("tar", ["-czf", path.join(work, "out.tar.gz"), "-C", content, "d0", "agent", "install.json"]);
    return await readFile(path.join(work, "out.tar.gz"));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
