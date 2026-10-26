import { execFile } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { checkReviewGate } from "../review/review-ledger.mjs";
import { listRecordEntries, RECORD_DIRECTORY } from "./record-store.mjs";
import { acceptedDesign, checkFrozenTests, SliceDesignError } from "./slice-design.mjs";
import { readWorkflowConfig, roadmapPaths } from "./workflow-config.mjs";

const run = promisify(execFile);

async function git(root, args, env) {
  const { stdout } = await run("git", args, { cwd: root, env, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Hash the project's working-tree content as a git tree, leaving out Prism records, plans, and the roadmap,
 * so writes of workflow records never make a verification stale while any source, test, or config change does.
 */
export async function contentTree(projectRoot, config) {
  const root = await realpath(projectRoot);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "prism-tree-"));
  try {
    const index = path.join(temporary, "index");
    await copyFile(path.resolve(root, await git(root, ["rev-parse", "--git-path", "index"])), index).catch(() => {});
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" };
    await git(root, ["add", "-A", "--", "."], env);
    const roadmap = roadmapPaths(config);
    const excluded = [RECORD_DIRECTORY, config.paths.plans, roadmap?.record, roadmap?.projection].filter(Boolean);
    await git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...excluded], env);
    return await git(root, ["write-tree"], env);
  } catch (error) {
    throw new SliceDesignError("verification_unavailable", `Verification needs a git work tree to identify what it tested: ${error.stderr?.trim() || error.message}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** The latest verification run of a slice, or null. */
export async function latestVerification(projectRoot, initiative, slice) {
  const entries = await listRecordEntries(projectRoot, { kind: "runs", initiative, slice });
  const latest = entries.filter((item) => item.entry?.kind === "verification").at(-1);
  return latest ? { id: latest.id, ...latest.entry } : null;
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
    else if (await contentTree(projectRoot, await readWorkflowConfig(projectRoot)) !== latest.tree) problems.push({ code: "verification_stale", message: `The project changed after the verification run ${latest.id}. Run verify_slice again.` });
  }
  let review = null;
  if (design.review === "required") {
    review = await checkReviewGate({ projectRoot, initiative, slice, gate: "completion" }).catch((error) => ({ ready: false, problems: [{ code: error.code ?? "evidence_missing", message: error.message }] }));
    problems.push(...(review.problems ?? []));
  }
  return { ready: problems.length === 0, design: true, ...(latest ? { verification: latest.id, tree: latest.tree } : {}), ...(review?.wave ? { wave: review.wave } : {}), problems };
}
