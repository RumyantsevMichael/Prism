# Contributing to lux

lux is a Claude Code plugin whose content is almost entirely prompts. There is no
build step and nothing to compile: a change is a change to Markdown that Claude
reads at session time.

## Repository layout

```
.claude-plugin/
  plugin.json        # plugin manifest - identity, version, metadata
  marketplace.json   # marketplace catalog listing this one plugin at "./"
skills/
  <name>/SKILL.md    # one directory per skill; the directory name is the skill name
```

Only the manifests live in `.claude-plugin/`. Everything Claude loads (`skills/`,
and later `agents/`, `hooks/`, `.mcp.json`) sits at the repository root. Putting a
component directory inside `.claude-plugin/` is the most common way to break a
plugin, and validation will not always catch it.

## Local development

Load the working tree into a live session:

```bash
claude --plugin-dir path/to/lux
```

Skills resolve under the plugin namespace, so `/lux:design` runs the local copy.
A `--plugin-dir` plugin shadows an installed one of the same name for that
session, so you can test against a version you already have installed.

After editing a skill, run `/reload-plugins` to pick it up without restarting.

## Validation

```bash
claude plugin validate . --strict
```

This checks both manifests against the published schema, and parses the YAML
frontmatter of every skill. `--strict` promotes unrecognized-field warnings to
errors, which catches typos in field names. CI runs the same command on every
push and pull request; run it locally before opening one.

With both manifests present the CLI validates the marketplace one. To validate
`plugin.json` in isolation, copy the plugin into a scratch directory without
`marketplace.json` and validate that.

## Writing skills

- **Frontmatter `description` is the trigger.** It is what Claude matches against
  when deciding whether to load the skill, so it should say both what the skill
  does and when to use it. Prefer concrete trigger phrases over abstract summary.
- **Add `disable-model-invocation: true`** for skills that should only ever run
  when the user explicitly asks, rather than being auto-selected mid-task.
- **Use `argument-hint`** for skills that take a target, and quote the value in
  YAML when it starts with `[`.
- **Sibling references resolve under the plugin namespace.** When a skill says
  "load `write-adr`", that means `lux:write-adr`. Names outside the plugin's own
  set resolve to Claude Code built-ins or project-local skills, and the `workflow`
  skill documents which are which. Keep that distinction intact when editing.
- **Every session skill reads `.claude/workflow-config.md` first.** A new skill
  that touches project paths should follow the same convention and fall back to
  the documented defaults when the file is absent.

## Versioning

Semantic versioning. Because skills are prompts rather than code, the levels map
to workflow behavior:

- **MAJOR** - a skill is removed or renamed, or its contract with the user changes
  in a way that breaks existing project setups: config keys, artifact paths, or
  the format of files a prior version wrote.
- **MINOR** - a new skill, a new capability inside an existing skill, or a new
  optional config key.
- **PATCH** - wording, clarity, and correctness fixes that leave the workflow's
  shape and artifacts unchanged.

`version` lives only in `.claude-plugin/plugin.json`. It is deliberately not
mirrored into the marketplace entry: Claude Code pins the plugin if a version is
set in either file, so two copies could drift and silently stop users from
receiving updates. One file, one bump.

Users only receive an update when that string changes, so a shipped fix needs a
version bump to reach anyone.

## Cutting a release

1. Bump `version` in `.claude-plugin/plugin.json`.
2. Move the `Unreleased` entries in `CHANGELOG.md` under the new version heading,
   and update the link references at the bottom of the file.
3. `claude plugin validate . --strict`
4. `claude plugin tag . --push` - reads the manifest version and pushes the
   matching git tag.

Users on the default install track `main` and pick up the change on their next
marketplace update. Users who pinned a tag stay put until they re-add at the new
one.
