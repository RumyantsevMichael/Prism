---
name: workflow-init
description: "Initialize Prism configuration and documentation paths for a project."
disable-model-invocation: true
sdm: "0.3"
---

# Initialize the workflow

Configured paths resolve from the project root.

## 1. Establish the inputs

- If `.prism/workflow.md` exists, read it as the update baseline.
- Otherwise, if `.claude/workflow-config.md` exists:
  1. Read it as migration input.
  2. Convert project-root paths such as `/docs/ADRs/` to `docs/ADRs/`.
  3. Preserve other values without reinterpretation.
- Otherwise, use the defaults in the configuration example below.

Migration leaves the legacy file unchanged.

## 2. Resolve project settings

1. Inspect applicable project instructions, package manifests, and common documentation paths without reading application source.
2. Identify existing documentation, languages, package layout, test and BDD commands, typechecks, formatters, tracker, and commit conventions.
3. Identify commands that write changes and the procedure that proves product behavior.
4. If GitHub is the proposed tracker, check for a GitHub remote and `gh` availability.
5. Present discovered settings and defaults, asking only about unresolved values or intended changes.
6. Include project prohibitions and sign-off requirements in that discussion.
7. In update mode, confirm proposed values together before writing, except values already accepted or explicitly authorized.

A missing BDD harness uses `none`, making feature files specification-only.
`Interaction style` defaults to `structured`, using structured input when available and plain text otherwise.
`plain-text` presents the same choices as numbered options in the message body.
Both styles follow the [workflow gate rules](../workflow/SKILL.md#supporting-procedures).
`Review browser` defaults to `auto`, selecting the internal browser on desktop and the system browser in CLI sessions.
`internal` and `external` select those browsers explicitly.

## 3. Write the configuration

1. Write `.prism/workflow.md` with all sections below and the resolved values.
2. For unavailable values, use `n/a`, except the BDD harness value `none`.

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
- Product strategy: n/a

## Stack
- Languages: <...>
- Test command: <...>
- BDD harness: <name and acceptance command, or none>
- Typecheck: <...>
- Lint/format: <command and whether it writes changes>

## Verification
- <How to exercise the product and prove a change.>

## Tracker
- System: GitHub issues
- Labels: type:bug, type:enhancement, type:docs, area:<name>, needs-design

## Commits
- Scopes: <vocabulary or free-form>
- Notes: <extra conventions>

## Interaction
- Interaction style: structured
- Review browser: auto

## Constraints
- <Project prohibitions and sign-off requirements.>
```

## 4. Create missing documentation

1. Create missing configured documentation directories, including parent directories for configured files.
2. If the glossary is absent, create its title and one-line purpose.
3. If the roadmap or sibling `roadmap.puml` is absent, create the missing artifact using the `roadmap` format.
4. Add a purpose README to each newly created requirements, ADR, feature, and user-guide directory.

Existing documentation remains unchanged.
Plans hold initiative coordination state, slice records, design diagrams, findings, and recovery evidence, with no seed file.

## 5. Return the result

1. Report changed paths and point to `workflow`.
2. For migration, explain that Prism no longer reads the legacy file and the user may remove it after review.

This skill does not commit its changes.
