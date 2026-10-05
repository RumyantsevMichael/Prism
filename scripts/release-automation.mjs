const releaseBranches = new Set(["release-please--branches--main", "release-please--branches--main--components--prism"]);
const pendingLabel = "autorelease: pending";
const repository = context => ({ owner: context.repo.owner, repo: context.repo.repo });

export async function pendingRelease(github, context) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repository(context), state: "closed", labels: pendingLabel, per_page: 100
  });
  const merged = [];
  for (const issue of issues.filter(issue => issue.pull_request)) {
    const { data: pr } = await github.rest.pulls.get({ ...repository(context), pull_number: issue.number });
    if (pr.merged && pr.base.ref === "main" && releaseBranches.has(pr.head.ref)) merged.push(pr);
  }
  if (merged.length > 1) throw new Error("Resolve multiple pending release pull requests before publication.");
  return merged[0]?.merge_commit_sha || "";
}

export async function mainIsCurrent(github, context, sha) {
  const { data } = await github.rest.git.getRef({ ...repository(context), ref: "heads/main" });
  return data.object.sha === sha;
}

export async function assertReleasePlan(github, context, sha, releaseRef) {
  if (!await mainIsCurrent(github, context, sha)) throw new Error("Main changed. The newer release workflow will prepare its source.");
  if (await pendingRelease(github, context) !== releaseRef) throw new Error("The pending release changed after verification.");
}

export async function releasePullRequest(github, context) {
  const prs = await github.paginate(github.rest.pulls.list, {
    ...repository(context), state: "open", base: "main", per_page: 100
  });
  const releases = prs.filter(pr => releaseBranches.has(pr.head.ref));
  if (releases.length > 1) throw new Error("Expected one release pull request.");
  const pr = releases[0];
  if (!pr) return undefined;
  if (pr.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}`
    || !pr.labels.some(label => label.name === pendingLabel)) throw new Error("The release pull request has an unexpected owner or label.");
  return { number: pr.number, sha: pr.head.sha, branch: pr.head.ref };
}

export async function promoteManifest(github, context, { number, sha, mainSha, manifest }) {
  await assertReleasePlan(github, context, mainSha, "");
  const pr = await releasePullRequest(github, context);
  if (!pr || pr.number !== number || pr.sha !== sha) throw new Error("The release pull request changed during runtime verification.");
  const repo = repository(context);
  const { data: parent } = await github.rest.git.getCommit({ ...repo, commit_sha: sha });
  const { data: tree } = await github.rest.git.createTree({
    ...repo, base_tree: parent.tree.sha,
    tree: [{ path: "vendor/native-runtime/manifest.json", mode: "100644", type: "blob", content: manifest }]
  });
  if (tree.sha === parent.tree.sha) return sha;
  const { data: commit } = await github.rest.git.createCommit({
    ...repo, message: "chore: promote verified native runtime", tree: tree.sha, parents: [sha]
  });
  // A concurrent branch update makes this non-fast-forward push fail.
  await github.rest.git.updateRef({ ...repo, ref: `heads/${pr.branch}`, sha: commit.sha, force: false });
  return commit.sha;
}
