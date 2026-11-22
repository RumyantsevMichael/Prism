// Launched sessions written as their supervisors leave them, for the archive tests: no host and no supervisor process runs, so nothing
// needs stopping. A "running" run names this test process as its supervisor and keeps its heartbeat fresh while the test beats it.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { actionProject, get, INITIATIVE, pageSession, post, startActionReview } from "./review-actions.mjs";
import { defer } from "./teardown.mjs";

export { get, INITIATIVE, post };

export const ENDED_STATES = ["finished", "failed", "stopped", "blocked"];
export const NOT_ENDED = "Only a finished, failed, stopped, or blocked session can be archived.";
export const READ_ONLY = "This tab can only read. To make changes, run prism review in this project, or ask the agent to present the review.";

const iso = (ms) => new Date(ms).toISOString();

/** One run of a launch record in the shape a supervisor writes it; state is finished, failed, stopped, blocked, or running. */
export function runOf(state, { number = 1, endedMinutesAgo = 5, ranMinutes = 3, model = "claude-opus-5-5" } = {}) {
  const now = Date.now();
  const ended = now - endedMinutesAgo * 60000;
  const started = (state === "running" ? now : ended) - ranMinutes * 60000;
  const token = createHash("sha256").update(`${number}/${state}/${started}/${Math.random()}`).digest("hex").slice(0, 32);
  const run = { number, cause: number === 1 ? "launch" : "person", token, supervisorPid: 0, hostPid: 0, startedAt: iso(started), heartbeatAt: iso(ended), outputAt: iso(ended), model,
    endedAt: iso(ended), exit: { code: 0, signal: null }, refusals: [], refusalCount: 0, hostError: null, stderr: null, stopGraceMs: 10000, stopRequestedAt: null };
  if (state === "failed") Object.assign(run, { exit: { code: 1, signal: null }, hostError: "the model is not offered for this account." });
  if (state === "stopped") Object.assign(run, { exit: { code: null, signal: "SIGTERM" }, stopRequestedAt: iso(ended - 1000) });
  if (state === "blocked") Object.assign(run, { refusals: [{ tool: "Bash", reason: "Denied by auto mode." }], refusalCount: 1 });
  if (state === "running") Object.assign(run, { supervisorPid: process.pid, hostPid: process.pid, heartbeatAt: iso(now), outputAt: iso(now), endedAt: null, exit: null });
  return run;
}

/**
 * A checkout with pending gates on INITIATIVE, a private review app folder as the process environment names it, and a review server over
 * the checkout with a write session. `launch(state)` writes a launched session of this checkout's record store; state "waiting" is a
 * finished run whose launch marked a pending gate. It returns the launch id.
 */
export async function archiveProject(t) {
  const { root, gateIds } = await actionProject(t, { gates: true });
  const app = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-archive-app-")));
  defer(t, () => rm(app, { recursive: true, force: true }));
  const saved = process.env.PRISM_REVIEW_APP_DIR;
  process.env.PRISM_REVIEW_APP_DIR = app;
  t.after(() => {
    if (saved === undefined) delete process.env.PRISM_REVIEW_APP_DIR;
    else process.env.PRISM_REVIEW_APP_DIR = saved;
  });
  const records = await import("../../../dist/server/session/launch-records.mjs");
  const env = { ...process.env, PRISM_REVIEW_APP_DIR: app };
  const store = await records.storeLocation(root);
  const { review, base, opened } = await startActionReview(t, root);
  const headers = await pageSession(review, opened);
  const trimmed = base.replace(/\/$/, "");
  let count = 0;
  const folderOf = (id) => records.launchFolder(env, id);
  const launch = async (state, { initiative = INITIATIVE, host = "claude-code", endedMinutesAgo = 5 + count, gate = gateIds.free } = {}) => {
    count += 1;
    const id = `launch-${createHash("sha256").update(`${root}/${count}`).digest("hex").slice(0, 16)}`;
    const folder = await records.createLaunchFolder(env, id);
    const run = runOf(state === "waiting" ? "finished" : state, { endedMinutesAgo });
    const hostSessionId = createHash("sha256").update(id).digest("hex").replace(/^(.{8})(.{4})(.{3})(.{3})(.{12}).*$/, "$1-$2-4$3-8$4-$5");
    await records.writeLaunchRecord(folder, { id, initiative, host, checkout: root, store, createdAt: run.startedAt, hostSessionId, runs: [run] });
    if (state === "waiting") await records.writeGateRecord(folder, { marks: [{ gate, at: run.endedAt }], answers: [] });
    return id;
  };
  const record = async (id) => JSON.parse(await readFile(path.join(folderOf(id), "launch.json"), "utf8"));
  /** Replaces a launch's record, as its supervisor or a resume would. */
  const rewrite = async (id, change) => records.writeLaunchRecord(folderOf(id), change(await record(id)));
  /** Adds a run in the given state, as a resume starts one, and answers the record. */
  const addRun = (id, state = "running") => rewrite(id, (current) => ({ ...current, runs: [...current.runs, runOf(state, { number: current.runs.length + 1, endedMinutesAgo: 0 })] }));
  /** Marks a pending gate as asked by the launch, as its session's own Prism server marks one. */
  const markGate = async (id, gate = gateIds.decision) => {
    const current = await records.readGateRecord(folderOf(id));
    await records.writeGateRecord(folderOf(id), { ...current, marks: [...current.marks, { gate, at: iso(Date.now()) }] });
  };
  /** Keeps every running run's heartbeat fresh. */
  const beat = async (id) => rewrite(id, (current) => ({ ...current, runs: current.runs.map((run) => (run.endedAt ? run : { ...run, heartbeatAt: iso(Date.now()) })) }));
  const archiveMark = async (id) => {
    try {
      return { info: await stat(path.join(folderOf(id), "archive.json")), value: JSON.parse(await readFile(path.join(folderOf(id), "archive.json"), "utf8")) };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const agents = async (headersFor = {}) => {
    const answer = await get(trimmed, "api/agents", headersFor);
    if (answer.status !== 200) throw new Error(`api/agents answered ${answer.status}: ${answer.text}`);
    return answer.json;
  };
  const archive = (body, withHeaders = headers) => post(trimmed, "api/agents/archive", body, withHeaders);
  const unarchive = (body, withHeaders = headers) => post(trimmed, "api/agents/unarchive", body, withHeaders);
  return { root, gateIds, app, env, store, review, base: trimmed, headers, launch, record, rewrite, addRun, markGate, beat, folderOf, archiveMark, agents, archive, unarchive };
}

/** The entry of a launch in an api/agents answer, or undefined. */
export const entryOf = (body, id) => body.agents.find((agent) => agent.id === `launch:${id}`);

/**
 * Opens review pages of the archive project in one browser: a plain review URL only reads, and `write` opens the page through its own
 * review server over the same checkout, whose first browser open carries a fresh write grant, since a server refuses a second open within
 * its lease. `requests` lists the archive and unarchive requests each page sent.
 */
export async function pageOpener(t, s) {
  const { launch, openPage, reviewUrl, waitForView } = await import("./kit-browser.mjs");
  const browser = await launch(t);
  return async (ref = "agents", { write = false, viewport = { width: 1440, height: 900 } } = {}) => {
    let url = reviewUrl(s.base, ref);
    if (write) {
      const tab = await startActionReview(t, s.root);
      await tab.review.open([]);
      const granted = new URL(tab.opened.at(-1));
      url = `${granted.origin}${granted.pathname.replace(/\/$/, "")}/review?artifact=${encodeURIComponent(ref)}${granted.hash}`;
    }
    const page = await openPage(browser, url, { viewport });
    page.requests = [];
    page.on("request", (request) => {
      if (/\/api\/agents\/(un)?archive$/.test(new URL(request.url()).pathname)) page.requests.push({ path: new URL(request.url()).pathname.replace(/^.*\/api\//, "api/"), body: request.postData() });
    });
    await waitForView(page);
    return page;
  };
}

/** The visible group headings of the Agents table, with their counts, such as `Needs you 2`. */
export const groupsOf = (page) => page.locator("prism-lib-table .prism-lib-group-name").evaluateAll((items) => items.filter((item) => item.getClientRects().length).map((item) => item.innerText.replace(/\s+/g, " ").trim()));
/** The Show choices with their counts, in order. */
export const showsOf = (page) => page.getByRole("radiogroup", { name: "Show" }).getByRole("radio").allInnerTexts().then((items) => items.map((item) => item.replace(/\s+/g, " ").trim()));
/** The ids of the visible rows, in order. */
export const rowsOf = (page) => page.locator("[data-agent]").evaluateAll((items) => items.filter((item) => item.getClientRects().length).map((item) => item.dataset.agent));
export const rowOf = (page, id) => page.locator(`[data-agent="${id}"]`);
export const agentsButton = (page) => page.getByRole("button", { name: /^Agents:/ });
export const agentsMenu = (page) => page.getByRole("dialog", { name: "Agents", exact: true });
export const textOf = (locator) => locator.evaluate((node) => node.innerText.replace(/\s+/g, " ").trim());
