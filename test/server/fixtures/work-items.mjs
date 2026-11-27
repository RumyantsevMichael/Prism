import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { git, storeProject, storeRead, storeWrite as writeInScope } from "./artifact-formats-store.mjs";
import { answerGate, reviewBrowser } from "./workspace-artifacts.mjs";

// Work items in a project with a record store: roadmap entries, their shaping records, and the gates a person answers in the review app.
export { storeRead };

/** Write one store artifact through update_artifact, in the checkout's repository scope api unless another scope is named. */
export const storeWrite = (call, file, content, options = {}) => writeInScope(call, file, content, { scope: "repository", ...options });

// Store locations of the checkout api's repository scope, by the configured path each kind of artifact has in the checkout.
const STORE_FOLDERS = Object.freeze([["docs/requirements/", "requirements/"], ["docs/ADRs/", "adrs/"]]);

/**
 * Place one requirement file or ADR in the repository scope api as another machine's sync brings it, without update_artifact,
 * since every write through Prism refuses an artifact that breaks its format: its bytes, and with a status its status record.
 * A file placed without a status reads as the status Prism gives an artifact it has no record of.
 */
export async function syncedFile(place, file, content, { status = null } = {}) {
  const [prefix, folder] = STORE_FOLDERS.find(([configured]) => file.startsWith(configured)) ?? [];
  if (!prefix) throw new Error(`syncedFile places requirement files and ADRs, not ${file}`);
  const location = `repositories/api/${folder}${file.slice(prefix.length)}`;
  const target = path.join(place.store, "artifacts", ...location.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  if (status === null) return;
  const record = path.join(place.store, "artifact-status", ...location.split("/"), "status.json");
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(record, `${JSON.stringify({ status, acceptedVersion: null, approval: null, pending: [], closed: [], history: [] })}\n`);
}

/** A conforming requirement file with one Active section, in the given status, whose statement is the given text. */
export function requirementText(title, { status = "Draft", statement = "When a person asks, the system shall do the thing." } = {}) {
  const approved = status === "Approved" ? "2026-11-10" : "n/a";
  return `# ${title}\n\nStatus: ${status}\nCreated: 2026-11-09\nApproved: ${approved}\n\n## Problem\n\nSomething is missing.\n\n## Goals\n\n- Do the thing.\n\n## Non-goals\n\n- n/a\n\n## Design questions\n\n- n/a\n\n<a id="1"></a>\n## 1. Do the thing\n\nPattern: Event-driven\n\nDisposition: Active\n\nRequirement: ${statement}\n\nRationale: People need it.\n\nRelated: n/a\n`;
}

/** The options of a Draft ADR as the version 2 format writes them. */
export const OPTIONS = Object.freeze([
  { title: "Poll the server", body: "Clients poll every minute.", costs: "One request a minute per client.", rulesOut: "Updates within a second.", preferred: null },
  { title: "Push over a socket", body: "The server pushes each change.", costs: "A socket per client.", rulesOut: "Clients behind proxies that drop sockets.", preferred: "Ada Reviewer, because the team already runs sockets" }
]);

/** A Draft ADR in the version 2 format with the given options, optionally with extra sections appended after the options. */
export function draftAdr(title, { options = OPTIONS, extra = "" } = {}) {
  const option = (item) => [`### ${item.title}`, "", item.body, "", `Costs: ${item.costs}`, `Rules out: ${item.rulesOut}`, ...(item.preferred ? [`Preferred by: ${item.preferred}`] : []), ""].join("\n");
  return `# ${title}\n\nStatus: Draft\nCreated: 2026-11-12\n\n## Requirements\n\nn/a\n\n## Problem\n\nClients must learn about changes.\n\n## Decision drivers\n\n- Freshness of what clients show.\n\n## Options\n\n${options.map(option).join("\n")}${extra}\n## Decision Log\n\nn/a\n`;
}

export const DRAFT_REQUIREMENT = "docs/requirements/sync.md";
export const APPROVED_REQUIREMENT = "docs/requirements/export.md";
export const DRAFT_ADR = "docs/ADRs/sync/change-delivery.md";

/** A link and a note that an input may carry. */
export const INPUT = Object.freeze({ link: "https://docs.example.invalid/brief", note: "The product brief for sync." });

/**
 * A store project with the roadmap entries `sync` (no requirements) and `export` (citing the Approved export.md§1),
 * a Draft requirement file sync.md, an Approved export.md, and a Draft ADR change-delivery.md, all in the repository scope api.
 * Returns { place, root, call, review }, where review is a review browser that holds a write session.
 */
export async function itemProject(context, { files = {}, entries = null, browser = true } = {}) {
  const { place, root, call } = await storeProject(context, {
    [DRAFT_REQUIREMENT]: requirementText("Sync changes"),
    [APPROVED_REQUIREMENT]: requirementText("Export reports", { status: "Approved" }),
    ...files
  });
  // Answers and comments record who gave them, from the checkout's Git identity.
  git(root, "config", "user.name", "Ada Reviewer");
  git(root, "config", "user.email", "ada@example.invalid");
  await storeWrite(call, DRAFT_ADR, draftAdr("Deliver changes to clients"));
  await addEntries(call, entries ?? [
    { id: "sync", title: "Sync changes", intent: "Clients see changes.", band: "Next" },
    { id: "export", title: "Export reports", intent: "People export reports.", band: "Next", requirements: ["export.md§1"] }
  ]);
  const review = browser ? await reviewBrowser(context, root) : null;
  return { place, root, call, review };
}

/** Add roadmap entries through update_roadmap add_initiative. */
export async function addEntries(call, entries) {
  const current = await call("get_roadmap", {});
  const result = await call("update_roadmap", { expectedRevision: current.value.revision, operations: entries.map((entry) => ({ op: "add_initiative", ...entry })) });
  assert.equal(result.value?.code ?? null, null, result.text);
  return result.value;
}

/** Apply operations to the roadmap at its current revision, returning the wrapped result. */
export async function roadmapUpdate(call, operations) {
  const current = await call("get_roadmap", {});
  return call("update_roadmap", { expectedRevision: current.value.revision, operations });
}

/** The derived roadmap entry of an item. */
export async function derivedEntry(call, id) {
  const roadmap = await call("get_roadmap", {});
  return roadmap.value.derived.find((entry) => entry.id === id);
}

/** get_work_item's value for an item. */
export async function workItem(call, item) {
  return (await call("get_work_item", { item })).value;
}

/** Apply operations to an item's shaping record at its current revision, returning the wrapped result. */
export async function itemUpdate(call, item, operations) {
  const current = await call("get_work_item", { item });
  return call("update_work_item", { item, expectedRevision: current.value?.revision ?? null, operations });
}

/** Apply operations and fail the test when Prism refuses them. */
export async function itemDone(call, item, operations) {
  const result = await itemUpdate(call, item, operations);
  assert.equal(result.value?.code ?? null, null, result.text);
  return result.value;
}

/** A question for a round, blocking unless said otherwise. */
export const question = (text, { recommended = "Yes.", settles = "Whether the item covers it.", blocking = true } = {}) => ({ question: text, recommended, settles, blocking });

/** Ask a round and return the gates it opened, in question order. */
export async function askRound(call, item, questions) {
  const value = await itemDone(call, item, [{ op: "ask_round", questions }]);
  return value.openedGates.map((gate) => gate.id);
}

/** Answer an item's gate as the person does in the review app, failing the test when the answer is refused. */
export async function answer(review, item, gate, choice = null, note = null) {
  const response = await answerGate(review, { initiative: item, id: gate, choice, note });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

/** Answer an item's gate and return the raw response, so a test can read a refusal. */
export const tryAnswer = (review, item, gate, choice = null, note = null) => answerGate(review, { initiative: item, id: gate, choice, note });

/** Ask a round of one question and answer it with the recommended answer, so the item has an answered round. */
export async function answeredRound(call, review, item) {
  const [gate] = await askRound(call, item, [question("Does it cover offline clients?")]);
  await answer(review, item, gate, "recommended");
  return gate;
}

/** The gate of an item's coordination state with the given id. */
export async function gateOf(call, item, id) {
  const state = (await call("get_coordination_state", { initiative: item })).value;
  return [...(state.state?.pending ?? []), ...(state.state?.closed ?? [])].find((gate) => gate.id === id) ?? null;
}
