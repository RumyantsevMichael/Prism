import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// On Windows a console program that a windowless process starts opens its own console window, which flashes on the person's screen.
// Prism's servers have no console, so every process they start, Git above all, is started with windowsHide.
const SOURCE = fileURLToPath(new URL("../../src/", import.meta.url));
const STARTERS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);

async function sources(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // Installed packages and the browser's own scripts start no processes of Prism's.
      if (entry.name !== "node_modules" && entry.name !== "public") found.push(...await sources(full));
    } else if (/\.(mjs|mts|js)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

// The text of a call's arguments, from the parenthesis after its name to the one that closes it, skipping strings and templates.
function argumentsAt(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\"" || character === "'" || character === "`") {
      for (index += 1; index < text.length && text[index] !== character; index += 1) if (text[index] === "\\") index += 1;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  return text.slice(open);
}

// Every name a file starts processes through: the starters it imports, under their local names, and the names it gives them again.
function starterNames(text) {
  const names = new Set();
  for (const [, list] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:child_process["']/g)) {
    for (const item of list.split(",")) {
      const [imported, local = imported] = item.trim().split(/\s+as\s+/);
      if (STARTERS.has(imported)) names.add(local);
    }
  }
  for (let grown = true; grown;) {
    grown = false;
    for (const [, alias, source] of text.matchAll(/(?:const|let|var)?\s*(\w+)\s*=\s*(?:[\w.]+\s*(?:\|\||\?\?)\s*)?(?:promisify\()?(\w+)\)?\s*[;,)\n]/g)) {
      if (names.has(source) && !names.has(alias)) {
        names.add(alias);
        grown = true;
      }
    }
  }
  return names;
}

test("every process Prism starts is started with windowsHide, so Windows opens no console window for it", async () => {
  const unhidden = [];
  let calls = 0;
  for (const file of await sources(SOURCE)) {
    const text = await readFile(file, "utf8");
    const names = starterNames(text);
    if (!names.size) continue;
    const call = new RegExp(`(?<![\\w.])(${[...names].join("|")})\\s*\\(|promisify\\((${[...names].join("|")})\\)\\s*\\(`, "g");
    for (const match of text.matchAll(call)) {
      const open = match.index + match[0].length - 1;
      const args = argumentsAt(text, open);
      // A wrapper that passes its options on to a starter is checked where the wrapper's own options are made.
      if (/^\(\s*\.\.\.\w+\s*\)$/.test(args)) continue;
      calls += 1;
      if (!/windowsHide\s*:\s*true/.test(args)) unhidden.push(`${path.relative(SOURCE, file)}:${text.slice(0, match.index).split("\n").length} ${match[0]}`);
    }
  }
  assert.ok(calls > 10, `found only ${calls} process starts, so the check no longer finds them`);
  assert.deepEqual(unhidden, []);
});
