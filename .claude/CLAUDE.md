# lux

lux is a Claude Code plugin distributed through its own marketplace.
Its content is prompts, not code: every skill is a Markdown file that Claude reads at session time.
There is no build, no test suite, and no runtime.
The consequence is that wording *is* behavior, and an edit that reads like a harmless rephrase can change what the plugin does.

## Read this first

**Before changing anything in this repository, read [CONTRIBUTING.md](../CONTRIBUTING.md).**
It covers the repository layout, the local development loop, validation, skill-authoring conventions, versioning, and how to cut a release.
This applies to subagents as well: if you are dispatched to work on a file here, read CONTRIBUTING.md before your first edit rather than inferring conventions from surrounding text.

## Non-negotiables

- **One sentence per line in every Markdown file, and never split a sentence across lines.**
  Code blocks, YAML frontmatter, and tables are exempt and stay as they are.
  This keeps diffs sentence-scoped, which is what makes review of a prose codebase tractable.
- **Only the manifests live in `.claude-plugin/`.**
  `skills/`, and any future `agents/`, `hooks/`, or `.mcp.json`, sit at the repository root.
  Moving a component directory inside `.claude-plugin/` silently breaks the plugin, and validation does not reliably catch it.
- **Run `claude plugin validate . --strict` before committing.**
  It parses both manifests and the frontmatter of every skill.
  CI runs the same command.
- **`version` lives only in `.claude-plugin/plugin.json`.**
  Do not mirror it into the marketplace entry.
  A version set in either file pins the plugin, so two copies can drift and silently stop users from receiving updates.

## Editing skills

A skill's frontmatter `description` is its trigger, not a summary: it decides whether Claude loads the skill at all.
Preserve both halves of it, what the skill does and when to use it, when editing.

Skill files cross-reference each other.
A reference to a sibling such as `write-adr` resolves under the plugin namespace as `lux:write-adr`, while a name outside the plugin's own set resolves to a Claude Code built-in or a project-local skill.
The `workflow` skill documents which names fall on which side.
Keep that distinction intact.

## Verifying bulk edits

When a change touches many files mechanically, verify content preservation rather than trusting line counts.
Snapshot the files first, then diff token-by-token with whitespace normalized.
A reformatting pass that drops a paragraph reports plausible line counts and looks clean in a summary.
