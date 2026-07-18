---
name: workflow-init
description: Initialize the spec-driven engineering workflow in a project — interview the user, write .claude/workflow-config.md, and scaffold the docs layout. Run once per project before using the workflow skills.
disable-model-invocation: true
---

# Initialize the workflow in this project

Set up a project to use the workflow skills (see the `workflow` overview skill for what the flow is). The output is `.claude/workflow-config.md` — the single file every workflow skill reads first — plus the scaffolded docs directories.

If `.claude/workflow-config.md` already exists, read it and switch to update mode: confirm each existing value instead of asking cold.

## 1. Discover before asking

Inspect the project first so the interview proposes rather than interrogates:

- Existing docs layout: look for existing ADR/decision dirs, feature specs, a roadmap, a glossary, user docs.
- Stack: language(s), package manager, test runner, BDD harness if any (cucumber-js, bun-test-cucumber, pytest-bdd, …), lint/format/typecheck commands.
- Repo shape: monorepo or single package; per-directory agent docs (AGENTS.md/CLAUDE.md).
- Tracker: GitHub remote (`gh` usable?) or something else.

## 2. Interview

Present findings as defaults and ask only what's genuinely open (plain-text options in the message body). Cover:

1. **Doc paths** — ADRs, plans (scratch), feature files, roadmap, glossary, user-guide, and a product strategy document if one exists (`roadmap`/`ideate` consult it when present). Defaults: `/docs/ADRs/`, `/docs/plans/`, `/docs/Features/`, `/docs/roadmap.md`, `/docs/Glossary.md`, `/docs/user-guide/`.
2. **Stack facts** — test command, BDD harness (or "none — feature files are spec-only"), typecheck/lint commands, whether lint is destructive (write-mode).
3. **Verification** — how to prove a change works on this project (dev server, CLI, test suite only).
4. **Tracker** — issue tracker and label conventions (defaults: GitHub, `type:bug`/`type:enhancement`, `area:*` scopes, `needs-design`).
5. **Commit conventions** — scopes vocabulary, anything beyond the standard conventional-commit rules.
6. **Interaction style** — how gates and decision forks should reach the user: `structured` (default; `AskUserQuestion` renders selectable options) or `plain-text` (a numbered list in the message body, answered in prose). Ask only if the user has a preference; otherwise take the default.
7. **Constraints** — anything the skills must never do here (e.g. never touch generated dirs, no pushes, sign-off requirements).

## 3. Write the config

Write `.claude/workflow-config.md` with exactly these sections (omit none; use "n/a" where empty):

```markdown
# Workflow config
<!-- Read by the workflow skills. Created by workflow-init. -->

## Product
- Name: <product name>
- One-line description: <...>

## Paths
- ADRs: /docs/ADRs/
- Plans (scratch): /docs/plans/
- Feature files: /docs/Features/
- Roadmap: /docs/roadmap.md
- Glossary: /docs/Glossary.md
- User guide: /docs/user-guide/
- Product strategy: <path, or "n/a">

## Stack
- Languages: <...>
- Test command: <...>
- BDD harness: <name + how acceptance tests run, or "none">
- Typecheck: <...>
- Lint/format: <command> <note if write-mode/destructive>

## Verification
- <how to run/exercise the product to prove a change works>

## Tracker
- System: GitHub issues
- Labels: type:bug, type:enhancement, type:docs; area:<name>; needs-design

## Commits
- Scopes: <vocabulary or "free-form">
- Notes: <extra conventions>

## Interaction
- Interaction style: structured | plain-text

## Constraints
- <project-specific MUST NOTs>
```

`Interaction style` picks how gates and decision forks reach the user: `structured` (the default) uses the `AskUserQuestion` tool to render selectable options; `plain-text` presents the same options as a numbered list in the message body, answered in prose. It changes delivery only — the framing rule in the `workflow` overview skill applies either way.

## 4. Scaffold

Create any configured doc directories that don't exist, with a minimal seed:

- Glossary: title + one-line purpose.
- Roadmap: empty Now/Next/Later skeleton (see `roadmap` skill for format).
- ADRs/Features/user-guide: directory with a short README stating what lives there.
- Plans dir: directory only (scratch space).

Do not scaffold over existing files; integrate with what's there.

## 5. Close

Summarize what was written and where, and point the user at the `workflow` skill for the map. Do not commit — committing is user-initiated.
