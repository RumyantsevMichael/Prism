import { execFile } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { checkReviewGate } from "../review/review-ledger.mjs";
import { RECORD_DIRECTORY } from "./record-store.mjs";
import { acceptedDesign, checkFrozenTests, latestVerification, SliceDesignError, unfinishedFrozenTestsOfOthers } from "./slice-design.mjs";
import { readWorkflowConfig, roadmapPaths } from "./workflow-config.mjs";

const run = promisify(execFile);

async function git(root, args, env, timeout = 0) {
  const { stdout } = await run("git", args, { cwd: root, env, maxBuffer: 16 * 1024 * 1024, timeout });
  return stdout.trim();
}

/**
 * Hash the project's working-tree content as a git tree, leaving out Prism records, plans, and the roadmap,
 * so writes of workflow records never make a verification stale while any source, test, or config change does.
 * With a commit, the same content of that commit is hashed instead, so the two trees differ exactly when the work tree has uncommitted changes.
 */
export async function contentTree(projectRoot, config, { commit = null, timeoutMs = 0 } = {}) {
  const root = await realpath(projectRoot);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "prism-tree-"));
  try {
    const index = path.join(temporary, "index");
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" };
    if (commit) await git(root, ["read-tree", commit], env, timeoutMs);
    else {
      await copyFile(path.resolve(root, await git(root, ["rev-parse", "--git-path", "index"])), index).catch(() => {});
      await git(root, ["add", "-A", "--", "."], env);
    }
    const roadmap = roadmapPaths(config);
    const excluded = [RECORD_DIRECTORY, config.paths.plans, roadmap?.record, roadmap?.projection].filter(Boolean);
    await git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...excluded], env, timeoutMs);
    return await git(root, ["write-tree"], env, timeoutMs);
  } catch (error) {
    throw new SliceDesignError("verification_unavailable", `Verification needs a git work tree to identify what it tested: ${error.stderr?.trim() || error.message}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * Whether the project still holds the content a verification run tested, apart from the frozen tests of other unfinished slices,
 * which Prism itself stages out of and back into the work tree as their designs are accepted and their slices start.
 * The run's tree is a git object written when the run hashed the work tree; when Git no longer has it, the trees must match whole.
 */
async function sameVerifiedContent(projectRoot, config, verifiedTree, ignored) {
  const current = await contentTree(projectRoot, config);
  if (current === verifiedTree || !ignored.length) return current === verifiedTree;
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

// A slice with an accepted design starts implementation at once and completes on a fresh passing verification run,
// plus an accepted implementation review when its design marks review as required.
// A slice designed before verification runs existed keeps the review-ledger gates.
export async function checkSliceGate({ projectRoot, initiative, slice, gate }) {
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
    problems.push(...(review.problems ?? []));
    if (review.ready && review.tree && review.tree !== latest?.tree) problems.push({ code: "review_stale", message: `The accepted review ${review.wave} covers an earlier verified result. Review the current result in a new wave.` });
  }
  return { ready: problems.length === 0, design: true, ...(latest ? { verification: latest.id, tree: latest.tree } : {}), ...(review?.wave ? { wave: review.wave } : {}), problems };
}
