// Generated from src/server/workflow/slice-gate.mts by scripts/native-build/compile.mjs.
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
const execFileAsync = promisify(execFile);
const run = (command, args, options = {}) => execFileAsync(command, args, { ...options, windowsHide: true });
async function git(root, args, env, timeout = 0) {
  const { stdout } = await run("git", args, { cwd: root, env, maxBuffer: 16 * 1024 * 1024, timeout });
  return stdout.trim();
}
async function contentTree(projectRoot, config, { commit = null, timeoutMs = 0 } = {}) {
  const root = await realpath(projectRoot);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "prism-tree-"));
  try {
    const index = path.join(temporary, "index");
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" };
    const roadmap = roadmapPaths(config);
    const excluded = [RECORD_DIRECTORY, config.paths.plans, roadmap?.record, roadmap?.projection].filter(Boolean);
    if (commit) await git(root, ["read-tree", commit], env, timeoutMs);
    else {
      const source = path.resolve(root, await git(root, ["rev-parse", "--git-path", "index"]));
      await copyFile(source, index).then(async () => {
        const { atime, mtime } = await stat(source);
        await utimes(index, atime, mtime);
      }).catch(() => {
      });
      await git(root, ["add", "-A", "--", ".", ...excluded.map((excludedPath) => `:(exclude)${excludedPath}`)], env);
    }
    await git(root, ["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", ...excluded], env, timeoutMs);
    return await git(root, ["write-tree"], env, timeoutMs);
  } catch (error) {
    throw new SliceDesignError("verification_unavailable", `Verification needs a git work tree to identify what it tested: ${error.stderr?.trim() || error.message}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const treeId = (value) => typeof value === "string" && TREE_ID.test(value);
async function changedPaths(projectRoot, from, to, { timeoutMs = 0 } = {}) {
  if (!treeId(from) || !treeId(to)) return null;
  if (from === to) return [];
  try {
    const root = await realpath(projectRoot);
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const prefix = (await run("git", ["rev-parse", "--show-prefix"], { cwd: root, env, timeout: timeoutMs })).stdout.trim();
    const { stdout } = await run("git", ["diff-tree", "-r", "-z", "--no-renames", "--name-only", ...prefix ? [`--relative=${prefix}`] : [], "--end-of-options", from, to], { cwd: root, env, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs });
    return stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}
async function treeReadable(projectRoot, tree) {
  if (!treeId(tree)) return false;
  try {
    await run("git", ["cat-file", "-e", `${tree}^{tree}`], { cwd: await realpath(projectRoot), env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return true;
  } catch {
    return false;
  }
}
const checkoutSegment = (realRoot) => createHash("sha256").update(realRoot).digest("hex").slice(0, 16);
const sliceRefs = (realRoot, initiative, slice) => `refs/prism/${initiative}/${slice}/${checkoutSegment(realRoot)}/`;
async function setSliceRef(projectRoot, initiative, slice, name, tree) {
  if (!treeId(tree)) return false;
  try {
    const root = await realpath(projectRoot);
    await run("git", ["update-ref", `${sliceRefs(root, initiative, slice)}${name}`, tree], { cwd: root });
    return true;
  } catch {
    return false;
  }
}
async function dropSliceRefs(projectRoot, initiative, slice) {
  try {
    const root = await realpath(projectRoot);
    const { stdout } = await run("git", ["for-each-ref", "--format=%(refname)", sliceRefs(root, initiative, slice)], { cwd: root });
    for (const name of stdout.split("\n").filter(Boolean)) await run("git", ["update-ref", "-d", name], { cwd: root });
  } catch {
  }
}
function startDeclaration(declaration) {
  return { root: declaration.root.identity, sharedPaths: [...declaration.sharedPaths], components: declaration.declared.map((component) => ({ component: component.identity, folder: component.folder })) };
}
const insideFolder = (file, folder) => file === folder || file.startsWith(`${folder}/`);
function crossesComponent(recorded, component, currentFolder, file) {
  if (recorded.sharedPaths.some((shared) => insideFolder(file, shared))) return false;
  if (component === recorded.root || currentFolder === "") return recorded.components.some((item) => item.component !== component && insideFolder(file, item.folder));
  const folder = recorded.components.find((item) => item.component === component)?.folder ?? currentFolder;
  return !insideFolder(file, folder);
}
async function sameVerifiedContent(projectRoot, config, verifiedTree, ignored) {
  const current = await contentTree(projectRoot, config);
  if (current === verifiedTree || !ignored.length || !treeId(verifiedTree)) return current === verifiedTree;
  const root = await realpath(projectRoot);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "prism-tree-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, "index"), GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" };
    const without = async (tree) => {
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
async function reviewStale(projectRoot, review, latest) {
  if (!review.tree || !latest || review.tree === latest.tree) return null;
  const paths = await changedPaths(projectRoot, review.tree, latest.tree);
  const shown = (paths ?? []).slice(0, STALE_PATHS_SHOWN), more = (paths?.length ?? 0) - shown.length;
  const named = paths === null ? "" : paths.length ? ` The paths that changed since the reviewed result: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.` : "";
  return { code: "review_stale", message: `The accepted review ${review.wave} covers an earlier verified result.${named} Review the current result in a new wave.`, ...paths === null ? {} : { paths } };
}
async function checkReviewCompletion(input) {
  const result = await checkReviewGate(input);
  if (input.gate !== "completion" || !result.wave) return result;
  const design = await acceptedDesign(input.projectRoot, input.initiative, input.slice);
  if (!design || design.review !== "required") return result;
  const stale = await reviewStale(input.projectRoot, result, await latestVerification(input.projectRoot, input.initiative, input.slice));
  return stale ? { ...result, ready: false, problems: [...result.problems, stale] } : result;
}
async function checkSliceGate({ projectRoot, initiative, slice, gate }) {
  const design = await acceptedDesign(projectRoot, initiative, slice);
  if (!design) return checkReviewGate({ projectRoot, initiative, slice, gate });
  if (gate === "implementation") return { ready: true, design: true, problems: [] };
  const problems = [];
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
    else if (!await sameVerifiedContent(projectRoot, await readWorkflowConfig(projectRoot), latest.tree, await unfinishedFrozenTestsOfOthers(projectRoot, initiative, slice))) problems.push({ code: "verification_stale", message: `The project changed after the verification run ${latest.id}. Run verify_slice again.` });
  }
  let review = null;
  if (design.review === "required") {
    review = await checkReviewGate({ projectRoot, initiative, slice, gate: "completion" }).catch((error) => ({ ready: false, problems: [{ code: error.code ?? "evidence_missing", message: error.message }] }));
    problems.push(...review.problems ?? []);
    const stale = review.ready ? await reviewStale(projectRoot, review, latest) : null;
    if (stale) problems.push(stale);
  }
  return { ready: problems.length === 0, design: true, ...latest ? { verification: latest.id, tree: latest.tree } : {}, ...review?.wave ? { wave: review.wave } : {}, problems };
}
export {
  changedPaths,
  checkReviewCompletion,
  checkSliceGate,
  checkoutSegment,
  contentTree,
  crossesComponent,
  dropSliceRefs,
  setSliceRef,
  startDeclaration,
  treeId,
  treeReadable
};
