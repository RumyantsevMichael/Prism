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
  server/            # mcp.mjs, cli.mjs, review-app.mjs, plugin-root.mjs, and one directory per domain
    workflow/        # coordination state, artifact storage, decision history
    review/          # review server, review ledger, browser assets in public/
    conservation/    # change map and conservation analysis
    repository-intelligence/  # providers, native semantic runtime, unit types
    session/         # host adapters, session facts, capacity, and tracing
  native-runtime/    # native helper packaged into runtime archives
  hooks/             # session hook entry points
dist/                # committed executable runtime and browser assets, same layout as src/
test/                # server and native helper tests
vendor/plantuml/     # pinned MIT PlantUML browser runtime
bin/                 # MCP and standalone review launchers
.claude-mcp.json     # Claude MCP server definition
.codex-mcp.json      # native Codex MCP server definition
```

Only the Claude manifests live in `.claude-plugin/`.
Only the Codex manifest lives in `.codex-plugin/`.
Shared components such as `skills/`, `hooks/`, and assets stay at the repository root.
Putting a shared component inside either manifest directory breaks one or both packages.
Do not name the Claude MCP definition `.mcp.json`.
Claude Code also reads a root `.mcp.json` as project config when a session runs in this repository.
That project server has no `${CLAUDE_PLUGIN_ROOT}` value, so it fails to start.

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

CI then calls a Prism record tool through real Claude Code and Codex CLIs, with a remote record store, and needs no model or API key:

```bash
node scripts/host-smoke.mjs            # every check; pass claude, codex, or codex-turn for one
```

Codex calls the tool through its app server, and Claude Code runs one print-mode turn against a scripted local Messages API.
The `codex-turn` check runs one `codex exec` turn of a code-mode model against a scripted local Responses API, after trusting Prism's hooks with the hashes that the app server's `hooks/list` reports.
It proves that the hooks run, that the first Prism call in a session resolves capacity, and that a Prism call naming an initiative is linked to that initiative's run cost.
It runs on the latest Codex, which CI installs beside the oldest supported one and passes as `CODEX_BIN`, so a Codex release that breaks Prism fails CI.
Codex names Prism's tools `mcp__prism_review__<tool>`, with an underscore, in hook inputs and in a code-mode script.
Codex gives a plugin's MCP server only a few basic environment variables and no plugin data directory, so forward any other variable the server reads through `env_vars` in `.codex-mcp.json`.

Run the review-server tests after a server or UI change:

```bash
npm test
```

The review app's browser tests run the real review page in Chromium through an installed Playwright, local or global, and skip with an install hint when there is none.
CI installs `playwright@1.63.0` and Chromium and sets `PRISM_REQUIRE_BROWSER=1`, under which a missing browser fails the run instead of skipping the browser tests.
Set the same variable locally to make sure the browser tests ran:

```bash
npm install -g playwright@1.63.0
npx playwright install chromium
PRISM_REQUIRE_BROWSER=1 npm test
```

### Review app design values

Every design value of the review app, such as a color, size, radius, shadow, blur, layer, font, or motion duration, lives in `src/server/review/public/kit/tokens.css`.
Every other stylesheet, element, and script of the review app reads these `--prism-*` custom properties and declares no raw value of its own.
A theme is one rule under `[data-theme="<name>"]` that gives a value to every semantic token, the `--prism-color-*` and `--prism-shadow-*` properties and `--prism-gradient-canvas`.
The shipped `light` and `dark` themes declare the same set of names, and light is also the `:root` default.
Compact sizes sit on `:root`, and `[data-density="comfortable"]` raises them.
To change a shade, change it in both themes when both need it, and keep the contrast pairs that `test/server/review-kit-tokens.test.mjs` checks.
The fonts, Geist and Geist Mono under the SIL Open Font License, ship in `kit/fonts/` and load from the review app, never from another host.
The review app stores the user's theme and density in `review-preferences.json` in the review app folder, so the choice survives a restart on another port.

The kit's elements live in `src/server/review/public/kit/elements/`, one `prism-<name>.js` per element, and `kit/kit.js` lists them in `KIT_ELEMENTS` and defines them.
An element that renders in shadow DOM names its stylesheets in a static `styles` list, such as `prism-button.css` beside it, and the kit fetches each one once and adopts it in every shadow root.
An element that renders in light DOM is styled in `kit/kit.css`.
The review page loads `kit/tokens.css`, `kit/kit.css`, and then one stylesheet per area under `styles/`: `shell.css` for the shell and its panels, `actions.css` for action lists such as Initiative settings, `workflow-views.css` for the workflow screens, and `record-views.css` for records, documents, and diagrams.
A screen's own rules go in its area stylesheet, read only tokens, and lay out kit elements rather than restyle them.
Each element class also carries a static `tag` and a static `catalog` of its purpose, options, states, and keys.
The component catalog at `<review URL>/kit/catalog` shows one entry per element from that `catalog`, with a live specimen per state from `SPECIMENS` in `kit/catalog.js`, plus long text and an unbroken name.
To add an element, add its file, list it in `KIT_ELEMENTS`, and add its specimens to `SPECIMENS`.
The review page's **Appearance** button, at the end of the status bar, links to the catalog.

The kit guard names each raw design value and each control styled or written around the kit:

```bash
node scripts/review-kit/kit-guard.mjs
```

It checks every stylesheet, script, and page under `src/server/review/public/` and prints `<file>:<line>: <rule> <value>` for each finding.
The `raw-value` rule names a color, size, layer, or time literal outside `kit/tokens.css` and `kit/plantuml-defaults.js`.
The `control-style` rule names a stylesheet selector outside `kit/` that styles a native control, a control role, a `prism-` element, or a class named like a control.
The `native-control` rule names a native control, a control role, or a `title` attribute written in a script or page outside `kit/`, also when a script sets the role or the title from code.
Every screen is on the kit, so the guard finds nothing, and `test/server/review-kit-everywhere.test.mjs` fails on any new finding.

Run a local human review from the repository root:

```bash
./bin/prism review
```

To try the entity-first review browser, run `node scripts/review-demo/seed.mjs` and start the review command it prints.
The seed builds a temporary project whose roadmap, initiative records, change map, review ledger, coordination state, recorded user gates, and evidence come from the real MCP tools.
The project is a Git repository, so the browser also lists its source files.
The browser opens on Attention, which lists the recorded user gates, and its sidebar nests the slices of each initiative being worked on and expands the path to the open page and every branch with a slice in progress, blocked, or claimed.
Answering a gate on Attention records the answer in the initiative's coordination state, and the `deliver-gate-answers` prompt hook passes answered gates to the agent with the next user message until the agent resolves them.
The same hook runs when a session resumes and lists every open gate, so the resumed agent waits on its unanswered gates again.
In Claude Code the `wait_for_user_gate` tool also returns the answer: Claude Code moves the call to the background after about two minutes (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`), its result wakes the idle session, and progress notifications every minute keep the stdio idle window (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`) from cancelling it.
In Codex, which does not move tool calls to the background, a call that carries the Codex session id in its `_meta` records a wait request in the review app folder and returns `deferred`, and the `wait-for-gate-answers` Stop hook of that session takes the request and waits up to 55 minutes, then blocks the stop with the answers so the turn continues.
The review page's write session is the credential for recording an answer: only a tab that Prism opened, with a one-time grant in its URL fragment, takes one, so a tab opened from a review URL that an agent printed can read but not answer.
The demo's `prism review` command opens such a tab, and the session URL alone grants read access only.
One shipped initiative record is written directly, because its completion gate needs accepted reviews that the offline demo cannot produce.

`node scripts/review-demo/seed-stress.mjs` builds an edge-case project with unbroken long names, long text, many records, a deep slice tree, and unreadable records.
After a UI change, run the kit guard, open the component catalog for each element you touched, and check the browser layout:

```bash
node scripts/review-demo/layout-check.mjs
```

The check opens every page of the demo, edge-case, and an empty project at phone, tablet, laptop, and wide window sizes, plus the menus, palette, and maximized views.
It fails on content that escapes its container, a page that scrolls the whole window, a control cut off by its container, and browser errors.
It also checks the component catalog of the empty project at each viewport and theme, and prints each catalog problem as `catalog <entry>: <problem> at <viewport> (<width>px), <theme>`.
`--catalog <url>` checks only the catalog at that URL.
`--viewports`, `--themes`, and `--screenshots <directory>` widen the run or keep screenshots for a visual pass.
Playwright is not a repository dependency, so the check uses an installed copy and is not part of CI.

A change to a screen that the UI kit mockup shows is done only when the rendered screen matches the mockup, so compare them side by side:

```bash
node scripts/review-demo/mockup-compare.mjs --out /tmp/mockup-compare
```

It puts the demo app into the state of each mockup scene (Attention with a gate and the Appearance menu, the roadmap with Who's working, a slice with its diagram beside it, the command palette, and the navigation drawer) and writes one picture per scene, width, theme, and density, the mockup on the left and the app on the right, with an `index.html` that shows them in pairs.
`--scenes`, `--widths`, `--themes`, and `--densities` narrow the run.
Read every pair: the layout check finds broken layouts, but only this comparison shows a screen that works and still looks nothing like the design.
Differences that come from the demo's data, or from mockup content that is deliberately out of scope, are expected; name them in the pull request.

With both manifests present the CLI validates the marketplace one.
To validate `plugin.json` in isolation, copy the plugin into a scratch directory without `marketplace.json` and validate that.

## Native semantic runtime

The new native subsystem uses strict TypeScript in `.mts` files.
Older server modules remain JavaScript, and newer modules such as the conservation store also use `.mts`.
Shared source unit, index, and worker message types live in `src/server/repository-intelligence/repository-unit-types.mts`.
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
The same release mirrors the pinned model files, and the manifest's `modelMirror` points the runtime at them before it falls back to Hugging Face.
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

The benchmark that compares plugin versions by the code their agents produce lives in the private `prism-research` repository, with the evidence behind Prism's design.
It stays out of this repository because every plugin install clones this repository onto the user's machine.
Hidden acceptance tests score each run, and a paired bootstrap over tasks decides whether a delta is real.
The harness loads a Prism checkout from `PRISM_REPO`, or from a sibling folder named `Prism` or `prism`.

Before you trust or publish a result:

1. Run `python3 bench/harness/bench.py selfcheck` in the research repository.
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

## Linking issues

Write `Closes #N` in the pull request description for each issue the pull request fully resolves, one per line, so GitHub closes the issue when the pull request merges into `main`.
Write `Refs #N` for an issue the pull request only partly addresses, and say what remains.
GitHub closes issues only for pull requests that merge into the default branch, so a pull request stacked on another branch closes nothing when it merges into that branch.
Carry its `Closes` lines into the pull request that reaches `main`.

## Merging pull requests

Squash-merge every pull request into `main`, and never merge it with a merge commit.
GitHub copies the pull request title into the body of a merge commit, so release-please reads both the merge commit and the branch commit with the same subject and lists the change twice in `CHANGELOG.md`.
The squash commit's subject is the pull request title, so write that title as a Conventional Commit.
Release-please also reads each Conventional Commit line in the squash commit's body as its own entry, so keep only the lines that name separate changes worth listing.

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
