// Generated from src/server/session/options-read-marker.mts by scripts/native-build/compile.mjs.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
const MAX_ANCESTORS = 16;
const POLL_MS = 50;
const optionsReadFolder = (env = process.env) => path.join(reviewAppDirectory(env), "options-reads");
const marking = (env) => env.PRISM_OPTIONS_READ === "1" || /^launch-[0-9a-f]{16}$/.test(env.PRISM_LAUNCH ?? "");
const markerFile = (env, pid) => path.join(optionsReadFolder(env), `${pid}.json`);
function ancestors() {
  const found = [process.ppid];
  let pid = process.ppid;
  for (let depth = 1; depth < MAX_ANCESTORS && pid > 1; depth += 1) {
    let stat;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      break;
    }
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!Number.isSafeInteger(parent) || parent <= 1) break;
    found.push(parent);
    pid = parent;
  }
  return found;
}
function markToolsListed(env = process.env) {
  if (!marking(env)) return;
  try {
    mkdirSync(optionsReadFolder(env), { recursive: true, mode: 448 });
    writeFileSync(markerFile(env, process.pid), JSON.stringify({ pid: process.pid, ancestors: ancestors(), at: (/* @__PURE__ */ new Date()).toISOString() }), { mode: 384 });
  } catch {
  }
}
function unmarkToolsListed(env = process.env) {
  if (!marking(env)) return;
  try {
    rmSync(markerFile(env, process.pid), { force: true });
  } catch {
  }
}
function takeMarker(env, agentPid) {
  let names;
  try {
    names = readdirSync(optionsReadFolder(env)).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return false;
  }
  for (const name of names) {
    const file = path.join(optionsReadFolder(env), name);
    let marker;
    try {
      marker = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(marker?.ancestors) || !marker.ancestors.includes(agentPid)) continue;
    try {
      rmSync(file, { force: true });
    } catch {
    }
    return true;
  }
  return false;
}
function toolsListed({ env, agentPid, deadline, stopped }) {
  return new Promise((resolve) => {
    const check = () => {
      if (takeMarker(env, agentPid)) resolve(true);
      else if (stopped() || Date.now() >= deadline) resolve(false);
      else setTimeout(check, POLL_MS);
    };
    check();
  });
}
export {
  markToolsListed,
  optionsReadFolder,
  toolsListed,
  unmarkToolsListed
};
