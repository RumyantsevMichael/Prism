#!/usr/bin/env node
// Checks an outside pull request against the contribution rules in CONTRIBUTING.md, "Contributing from outside".
// Every commit carries a Developer Certificate of Origin sign-off by its author, the description answers the ownership question,
// a feature links a proposal the maintainer accepted, and a non-trivial change that an employer or client may own carries the maintainer's authorization label.
// Pull requests by the repository owner or by a bot are exempt, because the owner already holds the rights in their own work.
// Usage: node scripts/check-contribution.mjs  (in a pull_request_target run; needs the gh CLI, GH_TOKEN, GITHUB_REPOSITORY, and GITHUB_EVENT_PATH)
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ACCEPTED_LABEL = "accepted";
export const AUTHORIZED_LABEL = "employer-authorized";
export const TRIVIAL_LINES = 20;

const OWNERSHIP = [
  ["own", "I own this contribution"],
  ["employer", "My employer or a client may own this contribution"],
  ["unsure", "I am not sure who owns this contribution"]
];

// Tests and generated files do not count toward the size of a change.
export const counted = (path) => !/(^|\/)test\/|\.test\.[cm]?[jt]s$|(^|\/)package-lock\.json$|\.lock$|^dist\//.test(path);

export function ownership(body = "") {
  const checked = body.split(/\r?\n/).filter((line) => /^\s*[-*] \[[xX]\]/.test(line));
  return OWNERSHIP.filter(([, text]) => checked.some((line) => line.includes(text))).map(([key]) => key);
}

export function linkedIssues(body = "") {
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  return [...new Set([...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+#(\d+)\b/gi)].map((match) => Number(match[1])))];
}

export function signedOff(commit) {
  const email = commit.authorEmail.toLowerCase();
  return [...commit.message.matchAll(/^Signed-off-by: .+ <([^>]+)>\s*$/gm)].some((match) => match[1].toLowerCase() === email);
}

export function checkContribution({ owner, pull, commits, files, issues }) {
  if (pull.author === owner || pull.authorType === "Bot") return { exempt: true, problems: [] };
  const problems = [];
  const labels = new Set(pull.labels);

  for (const commit of commits.filter((commit) => commit.parents < 2 && !signedOff(commit))) {
    problems.push(`Commit ${commit.sha.slice(0, 7)} has no \`Signed-off-by\` line for its author, ${commit.authorEmail}. Sign it off with \`git commit --amend -s\` or \`git rebase --signoff\` and push again.`);
  }

  const owners = ownership(pull.body);
  if (owners.length !== 1) problems.push("Check exactly one box under **Ownership** in the description.");

  const feature = /^feat(\([^)]*\))?!?:/.test(pull.title);
  if (feature && !issues.some((issue) => issue.labels.includes(ACCEPTED_LABEL))) {
    problems.push(`A feature needs a proposal issue the maintainer accepted. Link it with \`Closes #N\` or \`Refs #N\` once it carries the \`${ACCEPTED_LABEL}\` label.`);
  }

  const added = files.filter((file) => counted(file.path)).reduce((sum, file) => sum + file.additions, 0);
  const trivial = !feature && added <= TRIVIAL_LINES;
  if (owners.length === 1 && owners[0] !== "own" && !trivial && !labels.has(AUTHORIZED_LABEL)) {
    problems.push(`This change adds ${added} lines${feature ? " as a feature" : ""} that an employer or client may own, so it needs their signed authorization (docs/contributing/employer-authorization.md). The maintainer adds the \`${AUTHORIZED_LABEL}\` label once it arrives.`);
  }

  return { exempt: false, problems, added, feature };
}

function gh(path) {
  return JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).flat();
}

function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  const pull = { author: pr.user.login, authorType: pr.user.type, title: pr.title, body: pr.body ?? "", labels: pr.labels.map((label) => label.name) };
  const owner = repository.split("/")[0];
  const exempt = pull.author === owner || pull.authorType === "Bot";
  const commits = exempt ? [] : gh(`repos/${repository}/pulls/${pr.number}/commits?per_page=100`).map((commit) => ({
    sha: commit.sha, message: commit.commit.message, authorEmail: commit.commit.author.email, parents: commit.parents.length
  }));
  const files = exempt ? [] : gh(`repos/${repository}/pulls/${pr.number}/files?per_page=100`).map((file) => ({ path: file.filename, additions: file.additions }));
  const issues = exempt ? [] : linkedIssues(pull.body).flatMap((number) => {
    try {
      const issue = gh(`repos/${repository}/issues/${number}`)[0];
      return issue.pull_request ? [] : [{ number, labels: issue.labels.map((label) => label.name) }];
    } catch {
      return [];
    }
  });
  const result = checkContribution({ owner, pull, commits, files, issues });
  const summary = result.exempt
    ? `Pull request by ${pull.author}, exempt from the outside contribution checks.`
    : result.problems.length
      ? ["This pull request does not yet meet the contribution rules in CONTRIBUTING.md:", "", ...result.problems.map((problem) => `- ${problem}`)].join("\n")
      : "This pull request meets the contribution rules in CONTRIBUTING.md.";
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  for (const problem of result.problems) console.log(`::error::${problem}`);
  process.exitCode = result.problems.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
