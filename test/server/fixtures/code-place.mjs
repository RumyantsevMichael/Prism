import assert from "node:assert/strict";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { alias, eventually, git, networkStore, ok, place, server, startApp, storeCheckout, workspaceId, writeArtifact } from "./workspace-view.mjs";
import { checkout } from "./workspace-artifacts.mjs";
import { answerGate, reviewBrowser } from "./workspace-artifacts.mjs";

// The Code place's shared setup: code remotes built from branch steps with authors and dates, and a store workspace whose slices
// were verified on pushed branches of a Prism checkout, so the routes answer about work in progress and about other branches.

const DAY = 24 * 60 * 60 * 1000;

/** Run Git with extra environment, such as an author or a date, and return its trimmed output. */
export const gitWith = (cwd, env, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 }).toString().trim();

/** An ISO date `days` days before now, which a step's commit takes as its author and committer date. */
export const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

/**
 * Apply branch steps in a work tree whose origin is a code remote, then push every branch the steps name.
 * A step is { branch, from, files, remove, author, days, merge, orphan, message }: it checks out branch, creating it from `from` (default main) or as an orphan,
 * writes files, removes the paths in remove, and commits as author `days` days ago (default 1), or merges the branch `merge` with a merge commit.
 */
export async function applySteps(work, steps) {
  const known = new Set(git(work, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean));
  const named = new Set();
  for (const step of steps) {
    const { branch, from = "main", files = {}, remove = [], author = "Prism Test", days = 1, merge = null, orphan = false, message = `${branch} work` } = step;
    if (!known.has(branch)) {
      if (orphan) {
        git(work, "checkout", "-q", "--orphan", branch);
        git(work, "rm", "-rq", "--cached", ".");
        git(work, "clean", "-fdq");
      } else git(work, "checkout", "-q", "-b", branch, from);
      known.add(branch);
    } else git(work, "checkout", "-q", branch);
    named.add(branch);
    const date = daysAgo(days);
    const env = { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author.toLowerCase().replace(/[^a-z]+/g, ".")}@example.invalid`, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    if (merge) {
      gitWith(work, env, "merge", "-q", "--no-ff", "-m", `merge ${merge}`, merge);
      continue;
    }
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(work, file)), { recursive: true });
      await writeFile(path.join(work, file), contents);
    }
    for (const file of remove) await unlink(path.join(work, file));
    git(work, "add", "-A");
    gitWith(work, env, "commit", "-q", "--allow-empty", "-m", message);
  }
  for (const branch of named) git(work, "push", "-q", "-f", "origin", branch);
  git(work, "checkout", "-q", "main");
}

/**
 * A bare code remote at <parent>/<name>.git that serves filtered clones, whose main holds files committed `days` days ago,
 * with the work tree that built it at <parent>/<name>.work, then the steps applied; it returns { bare, work }.
 */
export async function codeRemote(parent, name, { files, days = 40, author = "Prism Test" }, steps = []) {
  const bare = path.join(parent, `${name}.git`);
  git(parent, "init", "-q", "--bare", "-b", "main", bare);
  git(bare, "config", "uploadpack.allowFilter", "true");
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  const work = path.join(parent, `${name}.work`);
  git(parent, "clone", "-q", bare, work);
  git(work, "checkout", "-q", "-b", "main");
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(work, file)), { recursive: true });
    await writeFile(path.join(work, file), contents);
  }
  git(work, "add", "-A");
  const date = daysAgo(days);
  gitWith(work, { GIT_AUTHOR_NAME: author, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, "commit", "-q", "-m", "main files");
  git(work, "push", "-q", "-u", "origin", "main");
  await applySteps(work, steps);
  return { bare, work };
}

/**
 * A store workspace that registers the repositories named in `repositories`, each { name, files, steps, days }, with a code remote that
 * https://github.com/acme/<name>.git reaches, and a review app with a write session and code content on for each repository listed in `on` (all by default).
 * It returns { where, store, prism (the app), id, remotes: { <name>: { bare, work } }, api(route) for GET below the workspace, ready(route) that waits past 202 }.
 */
export async function codeWorkspace(context, { repositories, on = null, app: appOptions = {} }) {
  const where = await place(context);
  const store = await networkStore(where);
  const remotes = {};
  for (const repository of repositories) {
    remotes[repository.name] = await codeRemote(where.parent, `${repository.name}-code`, repository, repository.steps ?? []);
    alias(`https://github.com/acme/${repository.name}.git`, remotes[repository.name].bare);
    await storeCheckout(context, where, repository.name, store.url);
  }
  const prism = await startApp(context, where, { workspaceFetchMs: 300, ...appOptions });
  await prism.grant();
  assert.equal((await prism.post("/api/workspaces", { url: store.url })).status, 200);
  const id = workspaceId(store.identity);
  for (const repository of repositories) {
    if (on && !on.includes(repository.name)) continue;
    const enabled = await prism.put(`/w/${id}/api/code/${repository.name}`, { enabled: true });
    assert.equal(enabled.status, 200, enabled.body);
  }
  const api = (route) => prism.get(`/w/${id}/api/code/${route}`);
  // A Code route answers 202 while Prism reads the branches of new tips, so a test waits until it answers otherwise.
  const ready = (route) => eventually(async () => {
    const answer = await api(route);
    return answer.status === 202 ? null : answer;
  }, 20000, `GET ${route} past preparing`);
  return { where, store, prism, id, remotes, api, ready };
}

/**
 * A Prism checkout of the repository `name` in the workspace, whose origin reaches the repository's code remote, with a store server and a review browser,
 * so that slices verified on its pushed branches record that repository and branch: it returns { root, server, review }.
 */
export async function prismCheckout(context, workspace, name) {
  const { where, store, remotes } = workspace;
  const root = await checkout(where, `${name}-checkout`, { store: store.url, sync: "on", repository: name });
  git(root, "remote", "set-url", "origin", `https://github.com/acme/${name}.git`);
  git(root, "fetch", "-q", "origin");
  // The checkout's own history joins the remote's main, so its branches share history with every branch of the remote.
  gitWith(root, {}, "merge", "-q", "--allow-unrelated-histories", "-m", "join the code remote", "origin/main");
  git(root, "push", "-q", "origin", "HEAD:main");
  git(remotes[name].work, "pull", "-q", "origin", "main");
  const prism = await server(context, where, root);
  const review = await reviewBrowser(context, root);
  return { root, server: prism, review };
}

const revision = async (prism, initiative) => ok(await prism.call("get_initiative", { initiative })).revision;

/** Verify a slice, answering the test command's approval gate when Prism asks for one, and return the run's result. */
export async function verify({ server: prism, review }, initiative, slice) {
  const asked = ok(await prism.call("verify_slice", { initiative, slice }));
  if (asked.status !== "approval_needed") return asked;
  assert.equal((await answerGate(review, { initiative, id: asked.gateId, choice: "allow" })).status, 200);
  return ok(await prism.call("verify_slice", { initiative, slice, approvalGate: asked.gateId }));
}

/**
 * An initiative on the roadmap's Now lane whose leaf slices are started and verified on pushed branches of the checkout.
 * slices is [{ slug, title, branch, from, files, remove, parent }]: a slice whose slug is the initiative's makes it an initiative without child slices,
 * and a slice with parent sits below the scope of that slug that scopes lists as [{ slug, title }].
 * Every design marks review required, so a passing run leaves its slice in progress, and the initiative stays in Work's In progress group.
 */
export async function verifiedWork(owner, { initiative, title, slices, scopes = [] }) {
  const { root, server: prism } = owner;
  const requirements = ["docs/requirements/code.md#1"];
  const assumption = "# Parts\n\n## Contract\n1. It works.\n\n## Assumptions\n- Unprobed: the parts hold; each part settles its own.\n";
  ok(await prism.call("update_initiative", { initiative, expectedRevision: null, operations: [{ op: "create", slug: initiative, title, requirements }] }));
  await writeArtifact(prism, `docs/plans/${initiative}/slice.md`, assumption.replace("# Parts", `# ${title}`));
  const split = async (parent, children) => ok(await prism.call("update_initiative", { initiative, expectedRevision: await revision(prism, initiative), operations: [{ op: "split", parent, children: children.map((child) => ({ slug: child.slug, title: child.title, requirements })), evidence: { kind: "unfrozen", assumption: "the parts hold", settledBy: children[0].slug } }] }));
  if (!(slices.length === 1 && slices[0].slug === initiative)) {
    await split(initiative, [...scopes, ...slices.filter((slice) => !slice.parent)]);
    for (const scope of scopes) {
      await writeArtifact(prism, `docs/plans/${initiative}/${scope.slug}/slice.md`, assumption.replace("# Parts", `# ${scope.title}`));
      await split(scope.slug, slices.filter((slice) => slice.parent === scope.slug));
    }
  }
  ok(await prism.call("update_roadmap", { expectedRevision: ok(await prism.call("get_roadmap", {})).revision, operations: [{ op: "add_initiative", id: initiative, title, intent: `${title}.`, band: "Now", requirements: ["code.md§1"] }] }));
  for (const slice of slices) {
    const frozen = `test/${initiative}-${slice.slug}.test.mjs`;
    git(root, "checkout", "-q", "main");
    await writeFile(path.join(root, frozen), "// frozen acceptance test\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", `freeze ${slice.slug}`);
    git(root, "push", "-q", "origin", "main");
    if (slice.slug !== initiative) {
      const folder = slice.parent ? `docs/plans/${initiative}/${slice.parent}/${slice.slug}` : `docs/plans/${initiative}/${slice.slug}`;
      await writeArtifact(prism, `${folder}/slice.md`, `# ${slice.title}\n\n## Changes\n- add \`${Object.keys(slice.files ?? {})[0] ?? "src/x.ts"}\`: work.\n`);
    }
    ok(await prism.call("update_initiative", { initiative, expectedRevision: await revision(prism, initiative), operations: [{ op: "accept_design", slug: slice.slug, frozenTests: [frozen], review: "required" }] }));
    ok(await prism.call("update_initiative", { initiative, expectedRevision: await revision(prism, initiative), operations: [{ op: "set_status", slug: slice.slug, status: "in-progress" }] }));
    git(root, "checkout", "-q", "-b", slice.branch, slice.from ?? "main");
    await commitWork(root, slice);
    git(root, "push", "-q", "origin", slice.branch);
    const run = await verify(owner, initiative, slice.slug);
    assert.equal(run.status, "passed", JSON.stringify(run));
  }
  git(root, "checkout", "-q", "main");
}

/**
 * An initiative on the roadmap's Now lane, without child slices, that is started but has no line of work yet:
 * no branch holds its work and no verification run names one, so it is in Work's In progress group and changes no code.
 */
export async function startedWork(owner, { initiative, title }) {
  const { root, server: prism } = owner;
  const requirements = ["docs/requirements/code.md#1"];
  ok(await prism.call("update_initiative", { initiative, expectedRevision: null, operations: [{ op: "create", slug: initiative, title, requirements }] }));
  await writeArtifact(prism, `docs/plans/${initiative}/slice.md`, `# ${title}\n\n## Contract\n1. It works.\n\n## Changes\n- add \`src/x.ts\`: work.\n`);
  ok(await prism.call("update_roadmap", { expectedRevision: ok(await prism.call("get_roadmap", {})).revision, operations: [{ op: "add_initiative", id: initiative, title, intent: `${title}.`, band: "Now", requirements: ["code.md§1"] }] }));
  const frozen = `test/${initiative}-${initiative}.test.mjs`;
  git(root, "checkout", "-q", "main");
  await writeFile(path.join(root, frozen), "// frozen acceptance test\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", `freeze ${initiative}`);
  git(root, "push", "-q", "origin", "main");
  ok(await prism.call("update_initiative", { initiative, expectedRevision: await revision(prism, initiative), operations: [{ op: "accept_design", slug: initiative, frozenTests: [frozen], review: "required" }] }));
  ok(await prism.call("update_initiative", { initiative, expectedRevision: await revision(prism, initiative), operations: [{ op: "set_status", slug: initiative, status: "in-progress" }] }));
}

/** Write a slice's files, remove its removed paths, and commit them on the checked-out branch. */
export async function commitWork(root, { title = "work", files = {}, remove = [] }) {
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
  for (const file of remove) await unlink(path.join(root, file));
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", title);
}

/** The strategy file of the api repository at main: eleven lines, of which branches change lines 2 and 4, or 2 to 4. */
export const STRATEGY = [
  "export class RequestRetryStrategy {",
  "  constructor(private attempts = 3) {}",
  "",
  "  shouldRetry(error: Error, attempt: number) {",
  "    return attempt < this.attempts && error.name === \"TimeoutError\";",
  "  }",
  "",
  "  delayFor(attempt: number) {",
  "    return Math.min(2 ** attempt * 100, 2_000);",
  "  }",
  "}"
].join("\n") + "\n";

/** STRATEGY with lines replaced: edits maps a 1-based line number to its new text, an array of lines to insert several. */
export function edited(text, edits) {
  const lines = text.replace(/\n$/, "").split("\n");
  const out = [];
  lines.forEach((line, index) => {
    const edit = edits[index + 1];
    if (edit === undefined) out.push(line);
    else out.push(...(Array.isArray(edit) ? edit : [edit]));
  });
  return `${out.join("\n")}\n`;
}

/** The api repository's branches that no slice owns: a release, a colleague's http change, a quiet experiment, an empty branch, and an unrelated history. */
const API_OTHERS = [
  { branch: "release/2026.11", author: "Sam Ortiz", days: 5, files: { "package.json": "{ \"version\": \"2026.11\" }\n" } },
  { branch: "feature/http", author: "Dana Kim", days: 2, files: { "src/http/client.ts": "export const client = (base: string) => fetch(base, { keepalive: true });\n" } },
  { branch: "old/experiment", author: "Ana Ruiz", days: 35, files: { "src/retry/backoff.ts": "export const backoff = (attempt: number) => attempt * 50;\n" } },
  { branch: "feature/empty", author: "Lee Park", days: 3 },
  { branch: "gh-pages", orphan: true, author: "Ana Ruiz", days: 6, files: { "index.html": "<p>docs</p>\n" } }
];

/** The web repository, whose main declares two components and whose feature/charts branch declares a third. */
export const WEB_REPOSITORY = {
  name: "web",
  files: { ".prism/workflow.md": "## Components\n- report-ui: packages/reports\n- shell: packages/shell\n", "packages/reports/table.ts": "table\n", "packages/shell/index.ts": "shell\n" },
  steps: [{ branch: "feature/charts", author: "Dana Kim", days: 1.5, files: { ".prism/workflow.md": "## Components\n- report-ui: packages/reports\n- shell: packages/shell\n- charts: packages/charts\n", "packages/charts/bar.ts": "bar\n" } }]
};

/** The infra repository, whose .prism/workflow.md declares no component, so the whole repository is its root component. */
export const INFRA_REPOSITORY = { name: "infra", files: { ".prism/workflow.md": "## Stack\n- Test command: none yet\n", "main.tf": "terraform\n" } };

/** The api repository's main files, with a secret and a binary file that the review app never shows. */
export const API_FILES = {
  "src/retry/strategy.ts": STRATEGY,
  "src/retry/backoff.ts": "export const backoff = (attempt: number) => attempt * 100;\n",
  "src/retry/legacy.ts": "export const legacy = true;\n",
  "src/http/client.ts": "export const client = (base: string) => fetch(base);\n",
  "docs/retries.feature": "Feature: Retries\n  Scenario: A timed-out request is retried\n",
  "package.json": "{ \"version\": \"2026.10\" }\n",
  ".env": "TOKEN=secret-token-of-api\n",
  "assets/logo.bin": "PNG\u0000\u0001\u0002binary\n"
};

/** The deadline slice's strategy.ts: lines 2 and 4 change, and a line follows line 4. */
export const DEADLINE_STRATEGY = edited(STRATEGY, {
  2: "  constructor(private attempts = 3, private deadlineMs = 10_000) {}",
  4: ["  shouldRetry(error: Error, attempt: number, elapsedMs: number) {", "    if (elapsedMs >= this.deadlineMs) return false;"]
});
/** The metrics slice's strategy.ts: lines 2 to 4 change and a line follows line 4, so Git counts 4 added and 3 removed lines, which overlap the deadline slice's lines. */
export const METRICS_STRATEGY = edited(STRATEGY, {
  2: "  constructor(private attempts = 3, private metrics = new Metrics()) {}",
  3: "  // Every attempt is counted.",
  4: ["  shouldRetry(error: Error, attempt: number): boolean {", "    this.metrics.count(\"retry\");"]
});
/** The tidy initiative's strategy.ts: only line 9 changes, far from the other slices' lines. */
export const TIDY_STRATEGY = edited(STRATEGY, { 9: "    return Math.min(2 ** attempt * 100, 5_000);" });

/**
 * The workspace the Code place's tests share, shaped like the approved mockups: api, web, and infra with code content on and mobile off;
 * on api, the initiative retries with the slices deadline and metrics, export with the scope download over two leaves on two branches, and tidy without child slices,
 * all verified on pushed branches, plus review/deadline, a colleague's branch that holds the deadline slice's strategy.ts, and the branches that API_OTHERS lists.
 */
export async function codePlaceWorkspace(context, options = {}) {
  const workspace = await codeWorkspace(context, {
    repositories: [{ name: "api", files: API_FILES, steps: API_OTHERS }, WEB_REPOSITORY, INFRA_REPOSITORY, { name: "mobile", files: { "app.swift": "app\n" } }],
    on: ["api", "web", "infra"],
    ...options
  });
  const owner = await prismCheckout(context, workspace, "api");
  await verifiedWork(owner, { initiative: "retries", title: "Harden request retries", slices: [
    { slug: "deadline", title: "Retry timed-out requests until a deadline", branch: "claude/retry-deadline", files: { "src/retry/strategy.ts": DEADLINE_STRATEGY, "src/retry/deadline.ts": "export const deadlineMs = 10_000;\n", "src/http/client.ts": "export const client = (base: string, signal: AbortSignal) => fetch(base, { signal });\n", "docs/retries.feature": "Feature: Retries\n  Scenario: A timed-out request is retried until its deadline\n" }, remove: ["src/retry/legacy.ts"] },
    { slug: "metrics", title: "Report retry attempts as metrics", branch: "codex/retry-metrics", files: { "src/retry/strategy.ts": METRICS_STRATEGY, "src/retry/metrics.ts": "export class Metrics { count(name: string) { return name; } }\n" } }
  ] });
  await verifiedWork(owner, { initiative: "export", title: "Export activity reports", scopes: [{ slug: "download", title: "Download signed reports" }], slices: [
    { slug: "download-api", title: "Sign report downloads", parent: "download", branch: "claude/signed-download", files: { "src/reports/sign.ts": "export const sign = (bytes: Uint8Array) => bytes;\n", "src/reports/route.ts": "export const route = \"/reports\";\n" } },
    { slug: "download-ui", title: "Offer signed downloads", parent: "download", branch: "claude/signed-download-ui", files: { "src/reports/button.ts": "export const button = \"Download\";\n" } }
  ] });
  await verifiedWork(owner, { initiative: "tidy", title: "Tidy retry limits", slices: [
    { slug: "tidy", title: "Tidy retry limits", branch: "claude/tidy", files: { "src/retry/strategy.ts": TIDY_STRATEGY } }
  ] });
  // A colleague's review branch holds the deadline slice's strategy.ts as it is, so the file has one version on both branches.
  git(owner.root, "checkout", "-q", "-b", "review/deadline", "main");
  await writeFile(path.join(owner.root, "src/retry/strategy.ts"), DEADLINE_STRATEGY);
  gitWith(owner.root, { GIT_AUTHOR_NAME: "Dana Kim", GIT_AUTHOR_EMAIL: "dana.kim@example.invalid" }, "commit", "-qam", "review the deadline");
  git(owner.root, "push", "-q", "origin", "review/deadline");
  git(owner.root, "checkout", "-q", "main");
  return { ...workspace, owner };
}
