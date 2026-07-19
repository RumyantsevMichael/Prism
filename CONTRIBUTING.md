# Contributing to prism

prism is a Claude Code plugin whose content is almost entirely prompts.
There is no build step and nothing to compile: a change is a change to Markdown that Claude reads at session time.

## Repository layout

```
.claude-plugin/
  plugin.json        # plugin manifest - identity, version, metadata
  marketplace.json   # marketplace catalog listing this one plugin at "./"
skills/
  <name>/SKILL.md    # one directory per skill; the directory name is the skill name
```

Only the manifests live in `.claude-plugin/`.
Everything Claude loads (`skills/`, and later `agents/`, `hooks/`, `.mcp.json`) sits at the repository root.
Putting a component directory inside `.claude-plugin/` is the most common way to break a plugin, and validation will not always catch it.

## Local development

Load the working tree into a live session:

```bash
claude --plugin-dir path/to/prism
```

Skills resolve under the plugin namespace, so `/prism:design` runs the local copy.
A `--plugin-dir` plugin shadows an installed one of the same name for that session, so you can test against a version you already have installed.

After editing a skill, run `/reload-plugins` to pick it up without restarting.

## Validation

```bash
claude plugin validate . --strict
```

This checks both manifests against the published schema, and parses the YAML frontmatter of every skill.
`--strict` promotes unrecognized-field warnings to errors, which catches typos in field names.
CI runs the same command on every push and pull request; run it locally before opening one.

With both manifests present the CLI validates the marketplace one.
To validate `plugin.json` in isolation, copy the plugin into a scratch directory without `marketplace.json` and validate that.

## Writing skills

- **Frontmatter `description` is the trigger.** It is what Claude matches against when deciding whether to load the skill, so it should say both what the skill does and when to use it.
  Prefer concrete trigger phrases over abstract summary.
- **Add `disable-model-invocation: true`** for skills that should only ever run when the user explicitly asks, rather than being auto-selected mid-task.
- **Use `argument-hint`** for skills that take a target, and quote the value in YAML when it starts with `[`.
- **Sibling references resolve under the plugin namespace.** When a skill says "load `write-adr`", that means `prism:write-adr`.
  Names outside the plugin's own set resolve to Claude Code built-ins or project-local skills, and the `workflow` skill documents which are which.
  Keep that distinction intact when editing.
- **Every session skill reads `.claude/workflow-config.md` first.** A new skill that touches project paths should follow the same convention and fall back to the documented defaults when the file is absent.

## Versioning

Semantic versioning.
Because skills are prompts rather than code, the levels map to workflow behavior:

- **MAJOR** - a skill is removed or renamed, or its contract with the user changes in a way that breaks existing project setups: config keys, artifact paths, or the format of files a prior version wrote.
- **MINOR** - a new skill, a new capability inside an existing skill, or a new optional config key.
- **PATCH** - wording, clarity, and correctness fixes that leave the workflow's shape and artifacts unchanged.

`version` lives only in `.claude-plugin/plugin.json`.
It is deliberately not mirrored into the marketplace entry: Claude Code pins the plugin if a version is set in either file, so two copies could drift and silently stop users from receiving updates.

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
On every push to `main` it opens or updates a release pull request that bumps `version` in `.claude-plugin/plugin.json`, writes the `CHANGELOG.md` section, and computes the next version from the commits since the last release.

`CHANGELOG.md` is generated from commit messages, so do not edit it by hand.
Anything you want to appear there belongs in a commit subject.

To ship, review that pull request and merge it.
Merging tags the commit and publishes a GitHub Release.
Nothing is released until you merge, which is the point: the computed bump is a guess derived from commit prefixes, and semantic versioning for prompts is a judgment call.
Check that the proposed bump matches the actual behavior change before merging.

To override the computed version, add a `Release-As: 1.0.0` footer to a commit on `main`.

Run `claude plugin validate . --strict` before merging a release pull request.
CI runs it on every push, but the release pull request is the last point where a broken manifest can still be caught cheaply.

Users on the default install track `main` and pick up the change on their next marketplace update.
Users who pinned a tag stay put until they re-add at the new one.

