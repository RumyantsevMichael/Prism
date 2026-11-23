// Generated from src/server/session/options-read-marker.mts by scripts/native-build/compile.mjs.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
const POLL_MS = 50;
const TOKEN_FLAG = "--prism-acp-token=";
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const LAUNCH_FLAG = "--prism-launch=";
const LAUNCH_PATTERN = /^launch-[0-9a-f]{16}$/;
const optionsReadFolder = (env = process.env) => path.join(reviewAppDirectory(env), "options-reads");
const markerFile = (env, token) => path.join(optionsReadFolder(env), `${token}.json`);
const newAcpToken = () => randomBytes(16).toString("hex");
const acpTokenArgument = (token) => `${TOKEN_FLAG}${token}`;
const acpLaunchArgument = (launch) => `${LAUNCH_FLAG}${launch}`;
function acpLaunch(argv = process.argv) {
  const argument = argv.slice(2).find((item) => item.startsWith(LAUNCH_FLAG));
  const launch = argument?.slice(LAUNCH_FLAG.length) ?? "";
  return LAUNCH_PATTERN.test(launch) ? launch : null;
}
function acpToken(argv = process.argv) {
  for (const argument of argv.slice(2)) {
    if (!argument.startsWith(TOKEN_FLAG)) continue;
    const token = argument.slice(TOKEN_FLAG.length);
    return TOKEN_PATTERN.test(token) ? token : null;
  }
  return null;
}
function markToolsListed(env = process.env, argv = process.argv, tools = []) {
  const token = acpToken(argv);
  if (!token) return;
  try {
    mkdirSync(optionsReadFolder(env), { recursive: true, mode: 448 });
    writeFileSync(markerFile(env, token), JSON.stringify({ pid: process.pid, tools, at: (/* @__PURE__ */ new Date()).toISOString() }), { mode: 384 });
  } catch {
  }
}
function unmarkToolsListed(env = process.env, argv = process.argv) {
  const token = acpToken(argv);
  if (!token) return;
  try {
    rmSync(markerFile(env, token), { force: true });
  } catch {
  }
}
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
function takeMarker(env, token) {
  const file = markerFile(env, token);
  try {
    statSync(file);
  } catch {
    return null;
  }
  let tools = [];
  try {
    const listed = JSON.parse(readFileSync(file, "utf8"))?.tools;
    if (Array.isArray(listed)) tools = listed.filter((name) => typeof name === "string" && TOOL_NAME.test(name));
  } catch {
  }
  try {
    rmSync(file, { force: true });
  } catch {
  }
  return tools;
}
function toolsListed({ env, token, deadline, stopped }) {
  return new Promise((resolve) => {
    const check = () => {
      const tools = takeMarker(env, token);
      if (tools) resolve(tools);
      else if (stopped() || Date.now() >= deadline) resolve(null);
      else setTimeout(check, POLL_MS);
    };
    check();
  });
}
export {
  acpLaunch,
  acpLaunchArgument,
  acpToken,
  acpTokenArgument,
  markToolsListed,
  newAcpToken,
  optionsReadFolder,
  toolsListed,
  unmarkToolsListed
};
