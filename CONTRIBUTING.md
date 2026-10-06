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
src/                 # editable server, native helper, and hook sources
dist/                # committed executable runtime and browser assets
test/                # server and native helper tests
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
npm run validate:sdm
```

The Claude validator checks the manifests and parses every skill frontmatter block.
`--strict` promotes unrecognized-field warnings to errors, which catches typos in field names.
The SDM validator checks the supported version and selected structural conventions.
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

## Native semantic runtime

The new native subsystem uses strict TypeScript in `.mts` files.
The existing server remains JavaScript.
Shared concept and worker message types live in `src/server/repository-concept-types.mts`.
Edit runtime sources under `src/`, then regenerate the complete runtime tree under `dist/`.
The build compiles TypeScript and copies handwritten JavaScript, browser assets, and runtime registries.
Commit both the edited sources and generated output.
The package ships generated JavaScript, so users do not need a TypeScript compiler.

```bash
npm ci --prefix src/native-runtime --ignore-scripts
npm ci --prefix scripts/native-build --ignore-scripts
npm run build:native
npm run check:native
node dist/native-runtime/patch-codegraph.mjs src/native-runtime/node_modules/@colbymchenry/codegraph-$(node -p "process.platform + '-' + process.arch")/lib/dist
npm run stage:native
node --liftoff-only --test test/native-runtime/*.test.mjs
node scripts/build-native-runtime.mjs
node scripts/native-build/smoke.mjs dist/native
node scripts/native-build/mcp-smoke.mjs dist/native
```

The freshness check verifies the complete output file set, contents, and executable permissions.
It rejects missing, changed, and obsolete output without changing files.
CI runs this check before any build that could repair committed output.
The dependency staging command copies installed helper dependencies into ignored `dist/native-runtime/node_modules`.
Run staging after installing or patching helper dependencies.
The build preserves staged dependencies and the ignored `dist/native` archive directory.
Tests and plugin launchers run the generated output.
The archive builder verifies generated files and copies pinned source dependencies without running installation scripts.
ONNX Runtime stays pinned to `1.22.0` because the `1.30.0` package omits the Intel macOS binding.
The smoke tests run the packaged Node helper without external executables.
The MCP smoke test also checks native estimates, offline reuse, responsive discovery, and source changes.
The release workflow builds and tests all five target platforms for the release pull request.
It publishes immutable runtime bundles, verifies the default manifest, and commits that manifest to the release pull request.
No separate publication branch or manual manifest copy is required for a plugin release.
The standalone runtime workflow still supports `codex/native-runtime-assets` and manual publication for diagnostics.
An empty bundle manifest leaves semantic preparation unavailable and preserves lexical results.
Use a host-owned `PRISM_NATIVE_ASSET_MANIFEST` path for local archive tests.
Project files cannot select that manifest.

The runtime publication workflow also tests the default manifest on all five platforms after publication.
Those checks include semantic discovery, retained receipts, and managed-addition readiness without a manifest override.
Only a successful run produces the `verified-native-manifest` artifact.
The release workflow promotes that artifact only when the release pull request and `main` still match the tested source.
It changes only `vendor/native-runtime/manifest.json` during promotion.
Run `node scripts/native-build/mcp-smoke.mjs --default` to verify the promoted manifest locally.

## Writing skills

- **Read the SDM documents first.** Before editing a skill, read [the Skill Definition Markdown standard](docs/skill-language.md) and [its validation behavior](docs/skill-language-validation.md).
- **Run SDM validation after each skill edit.** Run `npm run validate:sdm` and resolve every reported warning.
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
CI prepares the runtime bundles and adds their verified manifest to that pull request.
The `Release readiness` status reports the result of runtime preparation and package validation.

`CHANGELOG.md` is generated from commit messages, so do not edit it by hand.
Anything you want to appear there belongs in a commit subject.

Wait for `Release readiness` to pass before you merge the release pull request.
CI checks the merged package and its default runtime on all five platforms before it tags the commit and publishes a GitHub Release.
The runtime source check permits version and manifest updates but rejects changes to runtime, server, build, or pinned model inputs.
Failed checks prevent plugin publication.
Plugin versions are published only after that merge.
Release-please computes the version from commit prefixes, so the proposed version needs a review.
Check that the proposed bump matches the actual behavior change before merging.
Native asset prereleases can exist before the plugin release because CI must test their public download URLs.

Release preparation never writes directly to `main` or merges the release pull request.
Concurrent changes invalidate the older preparation run instead of overwriting newer source.
To retry a failed preparation, dispatch the `Release` workflow on `main` or rerun all jobs in the failed run.

To override the computed version, add a `Release-As: 1.0.0` footer to a commit on `main`.

### Release workflow setup

The release workflow authenticates with a `RELEASE_PLEASE_TOKEN` repository secret, a fine-grained personal access token scoped to this repository with **Contents** and **Pull requests** set to read/write.
It lets release pull requests and manifest promotion commits trigger normal pull request workflows.

If that secret is missing, the workflow falls back to `GITHUB_TOKEN`.
That fallback only works when **Allow GitHub Actions to create and approve pull requests** is enabled under Settings, Actions, General, Workflow permissions.
With neither in place the job fails with `GitHub Actions is not permitted to create or approve pull requests`.
The release workflow also invokes package validation directly, so token fallback does not bypass those checks.
The workflow uses its scoped `GITHUB_TOKEN` to report the `Release readiness` status.

Run the Claude validator and the Codex installation smoke test before merging a release pull request.
CI runs both checks on every push.

Users on the default install track `main` and pick up the change on their next marketplace update.
Users who pinned a tag stay put until they re-add at the new one.
