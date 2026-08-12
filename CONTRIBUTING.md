# Contributing to prism

prism is a Claude Code and Codex plugin whose workflow behavior is almost entirely prompts.
It also includes a Node.js MCP review server and a vendored browser renderer.
A change to Markdown changes agent behavior at task time.

## Repository layout

```
.claude-plugin/
  plugin.json        # Claude plugin manifest
  marketplace.json   # Claude marketplace
.codex-plugin/
  plugin.json        # Codex plugin manifest
.agents/plugins/
  marketplace.json   # Codex marketplace
skills/
  <name>/SKILL.md    # one directory per skill; the directory name is the skill name
server/              # MCP server, review UI, and tests
vendor/plantuml/     # pinned MIT PlantUML browser runtime
bin/                 # MCP and standalone review launchers
.mcp.json            # bundled MCP server definition
.codex-mcp.json      # native Codex MCP server definition
```

Only the Claude manifests live in `.claude-plugin/`.
Only the Codex manifest lives in `.codex-plugin/`.
Shared components such as `skills/`, `hooks/`, and assets stay at the repository root.
Putting a shared component inside either manifest directory breaks one or both packages.

## Local development

Load the working tree into Claude Code:

```bash
claude --plugin-dir path/to/prism
```

Skills resolve under the plugin namespace, so `/prism:design` runs the local copy.
A `--plugin-dir` plugin shadows an installed one of the same name for that session, so you can test against a version you already have installed.

After editing a skill, run `/reload-plugins` to pick it up without restarting.

Load the native Codex package through the repository marketplace:

```bash
codex plugin marketplace add .
codex plugin add prism@prism
```

Codex `0.147.0` or later is required.
Restart Codex after package changes when the installed copy does not refresh.

## Validation

```bash
claude plugin validate . --strict
```

This checks the Claude manifests and parses every skill frontmatter block.
`--strict` promotes unrecognized-field warnings to errors, which catches typos in field names.
CI also installs the native Codex package from an isolated temporary marketplace.
Run both checks before opening a pull request.

Run the review-server tests after a server or UI change:

```bash
npm test
```

Run a local human review from the repository root:

```bash
./bin/prism review
```

With both manifests present the CLI validates the marketplace one.
To validate `plugin.json` in isolation, copy the plugin into a scratch directory without `marketplace.json` and validate that.

## Writing skills

- **Frontmatter `description` is the trigger.** It is what Claude matches against when deciding whether to load the skill, so it should say both what the skill does and when to use it.
  Prefer concrete trigger phrases over abstract summary.
- **Add `disable-model-invocation: true`** for skills that should only ever run when the user explicitly asks, rather than being auto-selected mid-task.
- **Add `agents/openai.yaml`** for the equivalent Codex invocation policy.
  Set `policy.allow_implicit_invocation: false` for explicit-only skills.
- **Use `argument-hint`** for skills that take a target, and quote the value in YAML when it starts with `[`.
- **Sibling references use portable names.**
  Say "run `write-adr`" and let each host use its supported invocation mechanism.
- **Do not name host tools in shared prompt behavior.**
  Describe the required capability and its fallback.
- **Every workflow skill reads `.prism/workflow.md` first.**
  All configured paths resolve from the project root.

## Benchmarking a change

`bench/` holds a benchmark that compares plugin versions by the code their agents produce.
Hidden acceptance tests score each run, and a paired bootstrap over tasks decides whether a delta is real.
The methodology, the commands, and the threats to validity live in [bench/README.md](bench/README.md).

Before you trust or publish a result:

1. Run `python3 bench/harness/bench.py selfcheck`.
2. Compare arms with the same pinned model and at least 3 repetitions.
3. Quote the confidence interval, never the point delta alone.

The benchmark spends real API money on real runs.
Use `--mock` to test the pipeline itself for free.

## Versioning

Semantic versioning.
Because skills are prompts rather than code, the levels map to workflow behavior:

- **MAJOR** - a skill is removed or renamed, or its contract with the user changes in a way that breaks existing project setups: config keys, artifact paths, or the format of files a prior version wrote.
- **MINOR** - a new skill, a new capability inside an existing skill, or a new optional config key.
- **PATCH** - wording, clarity, and correctness fixes that leave the workflow's shape and artifacts unchanged.

While the version is below `1.0.0`, those levels are shifted down one: a breaking change bumps the minor, not the major.
This is release-please's `bump-minor-pre-major` setting, and it keeps the plugin in `0.x` while the workflow's shape is still moving.
Reaching `1.0.0` should be a deliberate decision that the skill set and its artifacts are stable, not the automatic consequence of the first breaking change.

`version` lives in both native plugin manifests because both hosts require it.
Release-please owns both values and updates them together.
CI rejects version drift between the manifests.
Do not put a version in either marketplace entry.

Users only receive an update when that string changes, so a shipped fix needs a version bump to reach anyone.

## Commit messages

Releases are generated from commit messages, so the prefix on a commit decides whether that change ever reaches users.
Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `style:`, `chore:`.
Mark a breaking change with `!` after the type, as in `feat!:`, or a `BREAKING CHANGE:` footer.

**Any commit that changes a file under `skills/` is `feat:` or `fix:`, never `docs:`.**
A skill is a prompt, so editing its wording changes what the plugin does.
`docs:` is reserved for `README.md` and `CONTRIBUTING.md`, the files that describe the plugin without being part of it.
Getting this wrong is silent: a behavior change committed as `docs:` produces no version bump, so it never reaches anyone who installed the plugin.

## Cutting a release

Releases are automated with [release-please](https://github.com/googleapis/release-please).
On each push to `main`, it opens or updates a release pull request.
The pull request updates both native manifest versions and writes the `CHANGELOG.md` section.
Release-please computes the next version from commits since the last release.

`CHANGELOG.md` is generated from commit messages, so do not edit it by hand.
Anything you want to appear there belongs in a commit subject.

To ship, review that pull request and merge it.
Merging tags the commit and publishes a GitHub Release.
Nothing is released until you merge, which is the point: the computed bump is a guess derived from commit prefixes, and semantic versioning for prompts is a judgment call.
Check that the proposed bump matches the actual behavior change before merging.

To override the computed version, add a `Release-As: 1.0.0` footer to a commit on `main`.

### Release workflow setup

The release workflow authenticates with a `RELEASE_PLEASE_TOKEN` repository secret, a fine-grained personal access token scoped to this repository with **Contents** and **Pull requests** set to read/write.
It is used instead of the default `GITHUB_TOKEN` because pull requests opened by `GITHUB_TOKEN` do not trigger other workflows, which would leave the release pull request unvalidated by CI.

If that secret is missing or expired, the workflow falls back to `GITHUB_TOKEN`.
That fallback only works when **Allow GitHub Actions to create and approve pull requests** is enabled under Settings, Actions, General, Workflow permissions.
With neither in place the job fails with `GitHub Actions is not permitted to create or approve pull requests`.

Run the Claude validator and the Codex installation smoke test before merging a release pull request.
CI runs both checks on every push.

Users on the default install track `main` and pick up the change on their next marketplace update.
Users who pinned a tag stay put until they re-add at the new one.
