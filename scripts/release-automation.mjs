const releaseBranches = new Set(["release-please--branches--main", "release-please--branches--main--components--prism"]);
const pendingLabel = "autorelease: pending";
const repository = context => ({ owner: context.repo.owner, repo: context.repo.repo });

// The open release pull request that readiness checks, if any.
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
