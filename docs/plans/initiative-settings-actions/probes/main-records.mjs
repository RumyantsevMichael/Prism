// Probes what the coordination state and the per-component index runtime on main accept, for the revised contract's assumptions.
// Run from the repository root: node docs/plans/initiative-settings-actions/probes/main-records.mjs
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The probe always uses a data folder of its own, so it never touches a real one.
const data = await mkdtemp(path.join(os.tmpdir(), "prism-probe-data-"));
process.env.PLUGIN_DATA = data;
const { updateCoordinationState, validateCoordinationState } = await import("../../../../dist/server/workflow/state.mjs");
const { fakeRuntime, project, settled } = await import("../../../../test/server/fixtures/component-indexes.mjs");
const { componentSources, indexComponents } = await import("../../../../dist/server/repository-intelligence/component-indexes.mjs");

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-probe-")));
await mkdir(path.join(root, ".prism"), { recursive: true });
await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans: docs/plans/\n");
execFileSync("git", ["init", "-q"], { cwd: root });
const probe = {};
try {
  const written = await updateCoordinationState({ projectRoot: root, initiative: "probe", expectedRevision: null, changes: { settings: { agentFlow: "mono" } } });
  probe.agentFlowWrite = { accepted: true, settings: written.state?.settings ?? written.current?.state?.settings ?? null, warnings: written.warnings ?? null };
} catch (error) { probe.agentFlowWrite = error.code; }
const { readCoordinationState } = await import("../../../../dist/server/workflow/state.mjs");
const current = await readCoordinationState({ projectRoot: root, initiative: "probe" });
probe.storedSettings = current.state.settings;
const file = path.join(root, ".prism/initiatives/probe/state.json");
const stored = JSON.parse(await readFile(file, "utf8"));
stored.pending = [{ id: "gate-0123456789abcdef", kind: "decision", question: "Keep it?", artifacts: [], options: [{ id: "keep", label: "Keep" }], askedAt: new Date().toISOString() }];
await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
probe.gateWithoutContextValid = (await validateCoordinationState({ projectRoot: root, initiative: "probe" })).valid;

const cleanups = [];
const t = { after(cleanup) { cleanups.push(cleanup); } };
const fixture = await project(t);
const { runtime, control } = await fakeRuntime(fixture.storage);
const declaration = await indexComponents(fixture.root);
const net = componentSources(fixture.root, declaration).find((entry) => entry.name === "net");
await runtime.prepareComponents([{ source: net.source, component: { name: net.name, identity: net.component, folder: net.folder } }], 2000, { retryLimited: true });
await settled(runtime, fixture.root);
probe.oneComponentBuilds = control.builds.map((build) => build.files);
await runtime.prepareComponents([{ source: net.source, component: { name: net.name, identity: net.component, folder: net.folder } }], 2000, { retryLimited: true });
await settled(runtime, fixture.root);
probe.upToDateRebuilds = control.builds.length - 1;
console.log(JSON.stringify(probe, null, 2));
for (const cleanup of cleanups) await cleanup();
await rm(root, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
