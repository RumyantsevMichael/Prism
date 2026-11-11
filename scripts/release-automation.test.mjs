import test from "node:test";
import assert from "node:assert/strict";
import { releasePullRequest } from "./release-automation.mjs";

const context = { repo: { owner: "example", repo: "prism" } };
function fixture() {
  const state = {
    pr: { number: 7, base: { ref: "main" }, labels: [{ name: "autorelease: pending" }],
      head: { sha: "pr-1", ref: "release-please--branches--main--components--prism", repo: { full_name: "example/prism" } } }
  };
  const github = { rest: { pulls: { list: () => {} } } };
  github.paginate = async () => (state.pr ? [state.pr] : []);
  return { state, github };
}

test("no release PR requires no readiness check", async () => {
  const { github, state } = fixture();
  state.pr = undefined;
  assert.equal(await releasePullRequest(github, context), undefined);
});

test("release discovery accepts both branch formats and ignores ordinary pull requests", async () => {
  const { github, state } = fixture();
  assert.deepEqual(await releasePullRequest(github, context), { number: 7, sha: "pr-1", branch: "release-please--branches--main--components--prism" });
  state.pr.head.ref = "release-please--branches--main";
  assert.equal((await releasePullRequest(github, context)).number, 7);
  state.pr.head.ref = "codex/feature";
  assert.equal(await releasePullRequest(github, context), undefined);
});

test("a foreign or unlabelled release branch is refused", async () => {
  for (const change of [state => { state.pr.head.repo.full_name = "other/prism"; }, state => { state.pr.labels = []; }]) {
    const { github, state } = fixture();
    change(state);
    await assert.rejects(releasePullRequest(github, context), /unexpected owner or label/);
  }
});
