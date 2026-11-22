import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";

// How a read of an ACP agent's run options, or a launched run on one, learns that the agent started Prism's server and listed its
// tools: the read or run names a new random token in the server's arguments, which every agent passes as given, and the server writes
// a marker named by that token into a private folder of the review app folder when it answers tools/list. The read or run waits for
// the marker of its own token, wherever in the agent's processes the server runs and whatever environment the agent gave it. A marker
// is only a signal, holds no secret, and is removed by the read or run that finds it or by the server when it stops.

const POLL_MS = 50;
const TOKEN_FLAG = "--prism-acp-token=";
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const LAUNCH_FLAG = "--prism-launch=";
const LAUNCH_PATTERN = /^launch-[0-9a-f]{16}$/;

export const optionsReadFolder = (env: NodeJS.ProcessEnv = process.env) => path.join(reviewAppDirectory(env), "options-reads");
const markerFile = (env: NodeJS.ProcessEnv, token: string) => path.join(optionsReadFolder(env), `${token}.json`);

/** A new token for one read or run. */
export const newAcpToken = () => randomBytes(16).toString("hex");

/** The server argument that names a token. */
export const acpTokenArgument = (token: string) => `${TOKEN_FLAG}${token}`;

/** The server argument that names the launch a run's server serves, for an agent that drops PRISM_LAUNCH from the server's environment. */
export const acpLaunchArgument = (launch: string) => `${LAUNCH_FLAG}${launch}`;

/** The launch that this server's arguments name, or null. */
export function acpLaunch(argv: readonly string[] = process.argv) {
  const argument = argv.slice(2).find((item) => item.startsWith(LAUNCH_FLAG));
  const launch = argument?.slice(LAUNCH_FLAG.length) ?? "";
  return LAUNCH_PATTERN.test(launch) ? launch : null;
}

/** The token that this server's arguments name, or null: a server started with one serves a read of run options or a launched run. */
export function acpToken(argv: readonly string[] = process.argv) {
  for (const argument of argv.slice(2)) {
    if (!argument.startsWith(TOKEN_FLAG)) continue;
    const token = argument.slice(TOKEN_FLAG.length);
    return TOKEN_PATTERN.test(token) ? token : null;
  }
  return null;
}

/**
 * Writes this server's marker, naming the tools it listed, when its arguments name a token; a failed write only leaves the read or run
 * to time out.
 */
export function markToolsListed(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv, tools: readonly string[] = []) {
  const token = acpToken(argv);
  if (!token) return;
  try {
    mkdirSync(optionsReadFolder(env), { recursive: true, mode: 0o700 });
    writeFileSync(markerFile(env, token), JSON.stringify({ pid: process.pid, tools, at: new Date().toISOString() }), { mode: 0o600 });
  } catch {}
}

/** Removes this server's marker, if it wrote one. */
export function unmarkToolsListed(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv) {
  const token = acpToken(argv);
  if (!token) return;
  try { rmSync(markerFile(env, token), { force: true }); } catch {}
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

// The names of the tools that the marker of token lists once it exists, an empty list for a marker that cannot be read, or null.
function takeMarker(env: NodeJS.ProcessEnv, token: string): string[] | null {
  const file = markerFile(env, token);
  try { statSync(file); } catch { return null; }
  let tools: string[] = [];
  try {
    const listed = JSON.parse(readFileSync(file, "utf8"))?.tools;
    if (Array.isArray(listed)) tools = listed.filter((name: unknown): name is string => typeof name === "string" && TOOL_NAME.test(name));
  } catch {}
  try { rmSync(file, { force: true }); } catch {}
  return tools;
}

/**
 * Resolves with the names of the tools that a server started with token listed, once it listed them, or null at the deadline or when
 * stopped() answers true.
 */
export function toolsListed({ env, token, deadline, stopped }: { env: NodeJS.ProcessEnv; token: string; deadline: number; stopped: () => boolean }): Promise<string[] | null> {
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
