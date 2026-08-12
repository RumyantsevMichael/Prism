# prism

prism is an agent workflow plugin distributed through its own marketplace.
Its workflow behavior comes from Markdown prompts that an agent reads at session time.
It also includes a local MCP review server that renders PlantUML source in the human's browser.
The consequence is that wording *is* behavior, and an edit that reads like a harmless rephrase can change what the plugin does.

## Read this first

**Before changing anything in this repository, read `CONTRIBUTING.md`.**
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
- **`version` lives in both native plugin manifests because both hosts require it.**
  Release-please owns both values and updates them together.
  CI rejects version drift between the manifests.
  Do not put a version in either marketplace entry.
- **Any commit touching `skills/` is `feat:` or `fix:`, never `docs:`.**
  Releases are computed from commit prefixes, and a skill is a prompt, so editing its wording changes what the plugin does.
  A behavior change committed as `docs:` produces no version bump and silently never reaches users.

## Editing skills

A skill's frontmatter `description` is its trigger, not a summary: it decides whether an agent loads the skill at all.
Preserve both halves of it, what the skill does and when to use it, when editing.

Skill files cross-reference each other.
A sibling reference such as `write-adr` resolves under the plugin namespace as `prism:write-adr`.
An external name resolves to a built-in or project-local skill.
The `workflow` skill documents which names fall on which side.
Keep that distinction intact.

## Verifying bulk edits

When a change touches many files mechanically, verify content preservation rather than trusting line counts.
Snapshot the files first, then diff token-by-token with whitespace normalized.
A reformatting pass that drops a paragraph reports plausible line counts and looks clean in a summary.
