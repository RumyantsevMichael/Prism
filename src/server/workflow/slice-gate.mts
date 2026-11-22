import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, realpath, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { checkReviewGate } from "../review/review-ledger.mjs";
import { RECORD_DIRECTORY } from "./record-store.mjs";
import { acceptedDesign, checkFrozenTests, latestVerification, SliceDesignError, unfinishedFrozenTestsOfOthers } from "./slice-design.mjs";
import { readWorkflowConfig, roadmapPaths } from "./workflow-config.mjs";
import type { WorkflowConfig } from "./workflow-config.mjs";

/** The part of a components declaration that a slice records with its start content. */
export interface StartDeclaration { root: string; sharedPaths: string[]; components: { component: string; folder: string }[] }

const execFileAsync = promisify(execFile);
// Every Git call hides its console window, which Windows would otherwise open for a console program started by a process without one.
const run = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number; timeout?: number } = {}) => execFileAsync(command, args, { ...options, windowsHide: true });

async function git(root: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 0) {
  const { stdout } = await run("git", args, { cwd: root, env, maxBuffer: 16 * 1024 * 1024, timeout });
  return stdout.trim();
}

/**
 * Hash the project's working-tree content as a git tree, leaving out Prism records, plans, and the roadmap,
 * so writes of workflow records never make a verification stale while any source, test, or config change does.
 * With a commit, the same content of that commit is hashed instead, so the two trees differ exactly when the work tree has uncommitted changes.
 */
export async function contentTree(projectRoot: string, config: WorkflowConfig, { commit = null, timeoutMs = 0 }: { commit?: string | null; timeoutMs?: number } = {}) {
  const root = await realpath(projectRoot);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "prism-tree-"));
  try {
    const index = path.join(temporary, "index");
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" };
    const roadmap = roadmapPaths(config);
    const excluded = [RECORD_DIRECTORY, config.paths.plans, roadmap?.record, roadmap?.projection].filter(Boolean) as string[];
    if (commit) await git(root, ["read-tree", commit], env, timeoutMs);
    else {
      // The copy keeps the index's modification time, so Git still re-reads a file changed in the same timestamp tick as the index ("racy" entries) instead of trusting its cached size and time.
      const source = path.resolve(root, await git(root, ["rev-parse", "--git-path", "index"]));
      await copyFile(source, index).then(async () => {
        const { atime, mtime } = await stat(source);
        await utimes(index, atime, mtime);
      }).catch(() => {});
      // Excluded paths are never added, so a record written or replaced while Git reads the work tree cannot fail the add.
      await git(root, ["add", "-A", "--", ".", ...excluded.map((excludedPath) => `:(exclude)${excludedPath}`)], env);
    }
    // The removal is forced because a record written while the project is hashed differs from both the temporary index and HEAD, which Git otherwise refuses to unstage.
    await git(root, ["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", ...excluded], env, timeoutMs);
    return await git(root, ["write-tree"], env, timeoutMs);
  } catch (error) {
    throw new SliceDesignError("verification_unavailable", `Verification needs a git work tree to identify what it tested: ${error.stderr?.trim() || error.message}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// A content tree recorded by Prism is a Git object identifier, so a recorded value that is not one never reaches Git, where it could read as an option.
const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether a recorded value is a Git object identifier of 40 or 64 lowercase hexadecimal digits. */
export const treeId = (value: unknown): value is string => typeof value === "string" && TREE_ID.test(value);

/**
 * The project-relative paths that differ between two content trees, in Git's order, or null when Git cannot compare them, such as when it no longer has one of the trees or a tree is not a Git object identifier.
 * A content tree holds the whole checkout, so in a project below its Git top folder only the paths inside the project count, relative to the project root.
 * A moved file is a removal and an addition, so a rename lists both of its paths.
 * `timeoutMs`, when given, stops a Git that does not answer in time, which also counts as Git that cannot compare.
 */
export async function changedPaths(projectRoot: string, from: unknown, to: unknown, { timeoutMs = 0 } = {}): Promise<string[] | null> {
  if (!treeId(from) || !treeId(to)) return null;
  if (from === to) return [];
  try {
    const root = await realpath(projectRoot);
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const prefix = (await run("git", ["rev-parse", "--show-prefix"], { cwd: root, env, timeout: timeoutMs })).stdout.trim();
    const { stdout } = await run("git", ["diff-tree", "-r", "-z", "--no-renames", "--name-only", ...(prefix ? [`--relative=${prefix}`] : []), "--end-of-options", from, to], { cwd: root, env, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs });
    return stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/** Whether Git still holds a content tree. */
export async function treeReadable(projectRoot: string, tree: string) {
  if (!treeId(tree)) return false;
  try {
    await run("git", ["cat-file", "-e", `${tree}^{tree}`], { cwd: await realpath(projectRoot), env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return true;
  } catch {
    return false;
  }
}

/**
 * The checkout segment of a slice's local refs: the first 16 lowercase hexadecimal digits of the SHA-256 of the project root's real path.
 * Linked worktrees and projects that share one Git repository share its refs, so each keeps its slices' refs under its own segment.
 */
export const checkoutSegment = (realRoot: string) => createHash("sha256").update(realRoot).digest("hex").slice(0, 16);

// A slice's start content and the content its latest passing run tested stay under local refs, which Prism never pushes, so git gc in any worktree keeps them while the slice needs them.
const sliceRefs = (realRoot: string, initiative: string, slice: string) => `refs/prism/${initiative}/${slice}/${checkoutSegment(realRoot)}/`;

/** Point this checkout's local ref `start` or `passed` of a slice at a content tree; a project where Git cannot write the ref keeps none. */
export async function setSliceRef(projectRoot: string, initiative: string, slice: string, name: string, tree: string) {
  if (!treeId(tree)) return false;
  try {
    const root = await realpath(projectRoot);
    await run("git", ["update-ref", `${sliceRefs(root, initiative, slice)}${name}`, tree], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

/** Delete every local ref of a slice under refs/prism/<initiative>/<slice>/<checkout>/ of this checkout, leaving other checkouts' refs in place. */
export async function dropSliceRefs(projectRoot: string, initiative: string, slice: string) {
  try {
    const root = await realpath(projectRoot);
    const { stdout } = await run("git", ["for-each-ref", "--format=%(refname)", sliceRefs(root, initiative, slice)], { cwd: root });
    for (const name of stdout.split("\n").filter(Boolean)) await run("git", ["update-ref", "-d", name], { cwd: root });
  } catch { /* A project without Git keeps no refs. */ }
}

/**
 * The part of a ## Components declaration a slice's boundary check reads, recorded with the slice's start content:
 * the shared paths, the root component, and every declared component's folder.
 */
export function startDeclaration(declaration: any): StartDeclaration {
  return { root: declaration.root.identity, sharedPaths: [...declaration.sharedPaths], components: declaration.declared.map((component: any) => ({ component: component.identity, folder: component.folder })) };
}

const insideFolder = (file: string, folder: string) => file === folder || file.startsWith(`${folder}/`);

/**
 * Whether a changed project-relative path leaves a component under a recorded declaration: it lies under no shared path, and either outside the component's folder or, for the root component, inside another component's folder.
 * A component declared after the start, which the record does not name, keeps the folder it has now.
 */
export function crossesComponent(recorded: StartDeclaration, component: string, currentFolder: string, file: string) {
  if (recorded.sharedPaths.some((shared: string) => insideFolder(file, shared))) return false;
  if (component === recorded.root || currentFolder === "") return recorded.components.some((item: { component: string; folder: string }) => item.component !== component && insideFolder(file, item.folder));
  const folder = recorded.components.find((item: { component: string; folder: string }) => item.component === component)?.folder ?? currentFolder;
  return !insideFolder(file, folder);
}

/**
 * Whether the project still holds the content a verification run tested, apart from the frozen tests of other unfinished slices,
 * which Prism itself stages out of and back into the work tree as their designs are accepted and their slices start.
 * The run's tree is a git object written when the run hashed the work tree; when Git no longer has it, the trees must match whole.
 */
async function sameVerifiedContent(projectRoot: string, config: WorkflowConfig, verifiedTree: string, ignored: string[]) {
  const current = await contentTree(projectRoot, config);
  if (current === verifiedTree || !ignored.length || !treeId(verifiedTree)) return current === verifiedTree;
  const root = await realpath(projectRoot);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "prism-tree-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, "index"), GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" };
    const without = async (tree: string) => {
      await git(root, ["read-tree", tree], env);
      await git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...ignored], env);
      return git(root, ["write-tree"], env);
    };
    return await without(verifiedTree) === await without(current);
  } catch {
    return false;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const STALE_PATHS_SHOWN = 20;
/**
 * The review_stale problem of an accepted implementation review whose verified tree is not the tree of the slice's latest verification run, or null when they match.
 * It names the project-relative paths that differ between the two trees, so a coordinator sees which change made the review stale.
 */
async function reviewStale(projectRoot: string, review: { wave?: string; tree?: string }, latest: { tree?: string } | null | undefined) {
  if (!review.tree || !latest || review.tree === latest.tree) return null;
  const paths = await changedPaths(projectRoot, review.tree, latest.tree);
  const shown = (paths ?? []).slice(0, STALE_PATHS_SHOWN), more = (paths?.length ?? 0) - shown.length;
  const named = paths === null ? "" : paths.length ? ` The paths that changed since the reviewed result: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.` : "";
  return { code: "review_stale", message: `The accepted review ${review.wave} covers an earlier verified result.${named} Review the current result in a new wave.`, ...(paths === null ? {} : { paths }) };
}
/**
 * check_review_gate: the review ledger's own gate, and for completion of a slice whose accepted design requires review, the same comparison with the latest verification run that set_status done applies,
 * so a gate that reads ready is one that set_status done accepts on its review.
 */
export async function checkReviewCompletion(input: Parameters<typeof checkReviewGate>[0]): Promise<any> {
  const result: any = await checkReviewGate(input);
  if (input.gate !== "completion" || !result.wave) return result;
  const design = await acceptedDesign(input.projectRoot, input.initiative, input.slice);
  if (!design || design.review !== "required") return result;
  const stale = await reviewStale(input.projectRoot, result, await latestVerification(input.projectRoot, input.initiative, input.slice));
  return stale ? { ...result, ready: false, problems: [...result.problems, stale] } : result;
}
// A slice with an accepted design starts implementation at once and completes on a fresh passing verification run,
// plus an accepted implementation review when its design marks review as required.
// A slice designed before verification runs existed keeps the review-ledger gates.
export async function checkSliceGate({ projectRoot, initiative, slice, gate }: { projectRoot: string; initiative: string; slice: string; gate: "implementation" | "completion" }): Promise<any> {
  const design = await acceptedDesign(projectRoot, initiative, slice);
  if (!design) return checkReviewGate({ projectRoot, initiative, slice, gate });
  if (gate === "implementation") return { ready: true, design: true, problems: [] };
  const problems: { code: string; message: string }[] = [];
  const latest = await latestVerification(projectRoot, initiative, slice);
  if (!latest) {
    problems.push({ code: "verification_missing", message: "Run verify_slice: completion needs a passing verification run." });
  } else if (!latest.passed) {
    problems.push({ code: "verification_failed", message: `The latest verification run ${latest.id} did not pass${latest.reason ? ` (${latest.reason})` : ""}.` });
  } else if (latest.designAcceptedAt !== design.acceptedAt) {
    problems.push({ code: "verification_stale", message: `The verification run ${latest.id} predates the current accepted design. Run verify_slice again.` });
  } else {
    const frozen = await checkFrozenTests(projectRoot, design.frozenTests);
    if (frozen.changed.length || frozen.missing.length) problems.push({ code: "frozen_tests_changed", message: `The frozen acceptance tests changed: ${[...frozen.changed, ...frozen.missing].join(", ")}.` });
    else if (!await sameVerifiedContent(projectRoot, await readWorkflowConfig(projectRoot), latest.tree, await unfinishedFrozenTestsOfOthers(projectRoot, initiative, slice) as string[])) problems.push({ code: "verification_stale", message: `The project changed after the verification run ${latest.id}. Run verify_slice again.` });
  }
  let review: any = null;
  if (design.review === "required") {
    review = await checkReviewGate({ projectRoot, initiative, slice, gate: "completion" }).catch((error) => ({ ready: false, problems: [{ code: error.code ?? "evidence_missing", message: error.message }] }));
    problems.push(...(review.problems ?? []));
    const stale = review.ready ? await reviewStale(projectRoot, review, latest) : null;
    if (stale) problems.push(stale);
  }
  return { ready: problems.length === 0, design: true, ...(latest ? { verification: latest.id, tree: latest.tree } : {}), ...(review?.wave ? { wave: review.wave } : {}), problems };
}
