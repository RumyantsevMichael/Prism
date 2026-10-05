import test from "node:test";
import assert from "node:assert/strict";
import { assertReleasePlan, pendingRelease, promoteManifest, releasePullRequest } from "./release-automation.mjs";

const context = { repo: { owner: "example", repo: "prism" } };
function fixture() {
  const state = {
    main: "main-1", pending: [], writes: [], race: false,
    pr: { number: 7, base: { ref: "main" }, labels: [{ name: "autorelease: pending" }],
      head: { sha: "pr-1", ref: "release-please--branches--main--components--prism", repo: { full_name: "example/prism" } } }
  };
  const github = { rest: {
    issues: { listForRepo: () => {} },
    pulls: { list: () => {}, get: async ({ pull_number }) => ({ data: state.pending.find(pr => pr.number === pull_number) }) },
    git: {
      getRef: async () => ({ data: { object: { sha: state.main } } }),
      getCommit: async () => ({ data: { tree: { sha: "original-tree" } } }),
      createTree: async data => { state.writes.push(data); return { data: { sha: "manifest-tree" } }; },
      createCommit: async data => { state.writes.push(data); return { data: { sha: "promoted-commit" } }; },
      updateRef: async data => {
        if (state.race) throw new Error("Update is not a fast forward");
        state.writes.push(data);
        return {};
      }
    }
  } };
  github.paginate = async method => method === github.rest.pulls.list ? (state.pr ? [state.pr] : [])
    : state.pending.map(pr => ({ number: pr.number, pull_request: {} }));
  return { state, github };
}
const promotion = { number: 7, sha: "pr-1", mainSha: "main-1", manifest: '{"verified":true}\n' };

test("only a merged release PR selects the immutable publication source", async () => {
  const { github, state } = fixture();
  assert.equal(await pendingRelease(github, context), "");
  state.pending.push({ ...state.pr, merged: false, merge_commit_sha: "unmerged" });
  assert.equal(await pendingRelease(github, context), "");
  state.pending[0].merged = true;
  state.pending[0].merge_commit_sha = "merged-source";
  assert.equal(await pendingRelease(github, context), "merged-source");
  state.pending.push({ ...state.pending[0], number: 8 });
  await assert.rejects(pendingRelease(github, context), /multiple pending/);
});

test("publication stops when main or the pending release changes after verification", async () => {
  const { github, state } = fixture();
  await assertReleasePlan(github, context, "main-1", "");
  state.main = "main-2";
  await assert.rejects(assertReleasePlan(github, context, "main-1", ""), /Main changed/);
  state.main = "main-1";
  state.pending.push({ ...state.pr, merged: true, merge_commit_sha: "unchecked-source" });
  await assert.rejects(assertReleasePlan(github, context, "main-1", ""), /pending release changed/);
});

test("promotion commits only the manifest on top of the tested PR head", async () => {
  const { github, state } = fixture();
  assert.equal(await promoteManifest(github, context, promotion), "promoted-commit");
  assert.deepEqual(state.writes[0].tree, [{ path: "vendor/native-runtime/manifest.json", mode: "100644", type: "blob", content: promotion.manifest }]);
  assert.deepEqual(state.writes[1].parents, ["pr-1"]);
  assert.deepEqual(state.writes[2], { ...context.repo, ref: "heads/release-please--branches--main--components--prism", sha: "promoted-commit", force: false });
});

test("stale, closed, foreign, and concurrently updated PRs cannot receive a manifest", async () => {
  for (const change of [
    state => { state.main = "main-2"; },
    state => { state.pr.head.sha = "pr-2"; },
    state => { state.pr = undefined; },
    state => { state.pr.head.repo.full_name = "other/prism"; }
  ]) {
    const { github, state } = fixture();
    change(state);
    await assert.rejects(promoteManifest(github, context, promotion));
    assert.deepEqual(state.writes, []);
  }
  const { github, state } = fixture();
  state.race = true;
  await assert.rejects(promoteManifest(github, context, promotion), /not a fast forward/);
  assert.equal(state.writes.length, 2);
});

test("no release PR requires no runtime preparation", async () => {
  const { github, state } = fixture();
  state.pr = undefined;
  assert.equal(await releasePullRequest(github, context), undefined);
});

test("release discovery accepts both branch formats and ignores ordinary pull requests", async () => {
  const { github, state } = fixture();
  assert.equal((await releasePullRequest(github, context)).number, 7);
  state.pr.head.ref = "release-please--branches--main";
  assert.equal((await releasePullRequest(github, context)).number, 7);
  state.pr.head.ref = "codex/feature";
  assert.equal(await releasePullRequest(github, context), undefined);
});
