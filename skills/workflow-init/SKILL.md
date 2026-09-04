---
name: workflow-init
description: "Initialize Prism configuration and documentation paths for a project."
disable-model-invocation: true
sdm: "0.3"
---

# Initialize the workflow

Every workflow skill reads this configuration first.

## 1. Select the mode

- When `.prism/workflow.md` exists:
  1. Read it.
  2. Switch to update mode.
  3. Confirm each existing value instead of asking without context.
- When only `.claude/workflow-config.md` exists:
  1. Read it once as migration input.
  2. Switch to migration mode.
  3. Convert project-root paths such as `/docs/ADRs/` to paths such as `docs/ADRs/`.
  4. Preserve every other value without reinterpretation.
  5. Do not edit or delete the legacy file.
- When neither configuration file exists, switch to initialization mode.

## 2. Discover the project

1. Inspect only common project metadata and documentation paths before the interview.
   - Find existing requirements, decisions, feature specifications, roadmap, glossary, and user documentation.
   - Identify languages, package managers, test runners, and BDD harnesses.
   - Identify lint, format, and typecheck commands.
   - Identify whether formatting or linting commands write changes.
   - Identify whether the repository is a monorepo or a single package.
   - Read the project instruction files that apply to this task.
   - Identify the issue tracker and whether a GitHub remote and `gh` are available.
   - Use targeted file-name searches and package manifests.
2. Stop after you can propose paths and commands for each interview topic.

- Don't
  - Read application source during initialization.

## 3. Interview the user

The default path values are declarative configuration values.

| Path | Default value |
| --- | --- |
| Requirements | `docs/requirements/` |
| ADRs | `docs/ADRs/` |
| Plans | `docs/plans/` |
| Feature files | `docs/Features/` |
| Roadmap | `docs/roadmap.md` |
| Glossary | `docs/Glossary.md` |
| User guide | `docs/user-guide/` |
| Product strategy | `n/a` |

All configured paths resolve from the project root.

- When no BDD harness exists:
  1. Record `none`.
  2. State that feature files are specification-only.

The default tracker is GitHub.
The default labels are `type:bug`, `type:enhancement`, `type:docs`, `area:<name>`, and `needs-design`.

`Interaction style` is `structured` or `plain-text`.
The default is `structured`.
Structured interaction uses the host's structured input capability when available and otherwise uses plain text.
Plain-text interaction presents the same options as a numbered list that the user answers in prose.
The interaction style changes delivery only.
The framing rule in `workflow` applies to both styles.

`Review browser` is `auto`, `internal`, or `external`.
The default is `auto`.
The `auto` value uses the internal browser in desktop sessions and the system browser in CLI sessions.
The `internal` value uses the internal browser.
The `external` value uses the system browser.

- Read [visual-review.md](../workflow/references/visual-review.md) for the review procedure.

1. Present discovered values and applicable configuration defaults.
2. Ask only about values that remain open.
   1. Confirm requirements, ADR, plan, feature, roadmap, glossary, user-guide, and optional product-strategy paths.
   2. Confirm the test command, BDD harness, typecheck command, lint command, and destructive command behavior.
   3. Confirm how to prove a change through a development server, CLI, or test suite.
   4. Confirm the tracker and label conventions.
   5. Confirm commit scopes and conventions beyond standard Conventional Commits.
   6. Confirm gate delivery and review-browser preferences only when the user has a preference.
   7. Confirm project-specific prohibitions and sign-off requirements.
3. Put plain-text options in the message body.

## 4. Write the configuration

1. Write `.prism/workflow.md` with exactly these sections and use equivalent migration values when migration mode applies.
2. When update mode lacks the Requirements path, add it with the confirmed value.
3. Do not omit a section.
4. Use `n/a` for an empty value.

```markdown
# Workflow config
<!-- Read by the workflow skills. Created by workflow-init. -->

## Product
- Name: <product name>
- One-line description: <...>

## Paths
- Requirements: docs/requirements/
- ADRs: docs/ADRs/
- Plans (coordination scratch): docs/plans/
- Feature files: docs/Features/
- Roadmap: docs/roadmap.md
- Glossary: docs/Glossary.md
- User guide: docs/user-guide/
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
- Labels: type:bug, type:enhancement, type:docs, area:<name>, needs-design

## Commits
- Scopes: <vocabulary or "free-form">
- Notes: <extra conventions>

## Interaction
- Interaction style: structured | plain-text
- Review browser: auto | internal | external

## Constraints
- <project-specific MUST NOTs>
```

## 5. Scaffold documentation

1. Identify the configured documentation directories and files that already exist.
2. Create all configured documentation directories that do not exist.
3. Leave the plans directory without a seed file.
4. Reserve plans for initiative plans, coordination snapshots, slice findings, and recovery records.
5. Integrate with existing documentation.
6. When the glossary does not exist, create it with a title and one-line purpose.
7. When the roadmap does not exist, create it with empty roadmap prose.
8. Follow the `roadmap` skill for the roadmap format.
9. When `roadmap.puml` does not exist, create the sibling dependency graph.
10. Add a short README to each new requirements, ADR, feature, and user-guide directory.
11. State what belongs in each README's directory.

- Don't
  - Overwrite an existing file.

## 6. Close

- When migration mode applies, report that Prism no longer reads the legacy file.
- When migration mode applies, tell the user that they may remove the legacy file after review.
- Summarize what changed and where.
- Point the user to the `workflow` skill for the workflow map.
- Do not commit because commits are user-initiated.
