#!/usr/bin/env node
// Run the record store sync suites with a chosen Git first on PATH, so the sync can be checked on an older Git than the one installed.
// Usage: node scripts/test-store-sync.mjs [--git <path to a git binary>] [--init-shim] [any node --test option ...]
// --init-shim forces the shim that gives `git init` the -b option, which Git before 2.28 lacks and the suites' fixtures use; it is on by itself for such a Git.
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUITES = [
  "record-store-sync.test.mjs",
  "record-store-sync-paths.test.mjs",
  "record-store-sync-raw-files.test.mjs",
  "record-store-sync-crash.test.mjs",
  "record-store-sync-old-git.test.mjs",
  "record-store-sync-git-settings.test.mjs",
  "record-store-sync-remote-side.test.mjs",
  "record-store-sync-letter-case.test.mjs",
  "remote-record-store.test.mjs"
];

const args = process.argv.slice(2);
let gitPath = null;
let forceShim = false;
const passed = [];
for (let at = 0; at < args.length; at++) {
  if (args[at] === "--git") gitPath = args[++at];
  else if (args[at].startsWith("--git=")) gitPath = args[at].slice("--git=".length);
  else if (args[at] === "--init-shim") forceShim = true;
  else passed.push(args[at]);
}

const real = gitPath ? path.resolve(gitPath) : execFileSync("sh", ["-c", "command -v git"]).toString().trim();
const reported = execFileSync(real, ["--version"]).toString().trim();
const [major, minor] = (/(\d+)\.(\d+)/.exec(reported) ?? [0, 0, 0]).slice(1).map(Number);
const lacksInitBranch = major < 2 || (major === 2 && minor < 28);
console.log(`Store sync suites with ${reported} (${real}).`);
if (major < 2 || (major === 2 && minor < 25)) console.log("Prism refuses to sync on a Git older than 2.25, so the suites fail by design on this Git.");

const bin = await mkdtemp(path.join(os.tmpdir(), "prism-store-sync-git-"));
const shim = forceShim || lacksInitBranch;
await writeFile(path.join(bin, "git"), `#!/usr/bin/env bash
real=${JSON.stringify(real)}
if [[ ${shim ? 1 : 0} == 1 ]]; then
  args=("$@"); pre=(); i=0
  while (( i < \${#args[@]} )); do case "\${args[i]}" in -C|-c) pre+=("\${args[i]}" "\${args[i+1]}"); i=$((i + 2)) ;; *) break ;; esac; done
  if [[ "\${args[i]}" == "init" ]]; then
    rest=(); branch=""; dir=""; j=$((i + 1))
    while (( j < \${#args[@]} )); do
      a="\${args[j]}"
      case "$a" in
        -b|--initial-branch) branch="\${args[j+1]}"; j=$((j + 2)); continue ;;
        --initial-branch=*) branch="\${a#*=}" ;;
        -*) rest+=("$a") ;;
        *) rest+=("$a"); dir="$a" ;;
      esac
      j=$((j + 1))
    done
    "$real" "\${pre[@]}" init "\${rest[@]}" || exit $?
    if [[ -n "$branch" ]]; then
      into=(); [[ -n "$dir" ]] && into=(-C "$dir")
      "$real" "\${pre[@]}" "\${into[@]}" symbolic-ref HEAD "refs/heads/$branch" || exit $?
    fi
    exit 0
  fi
fi
exec "$real" "$@"
`);
await chmod(path.join(bin, "git"), 0o755);

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "server");
const { NODE_TEST_CONTEXT: _, ...inherited } = process.env;
const child = spawn(process.execPath, ["--test", ...passed, ...SUITES.map((suite) => path.join(here, suite))], { env: { ...inherited, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: "inherit" });
child.on("close", async (code) => {
  await rm(bin, { recursive: true, force: true });
  process.exit(code ?? 1);
});
