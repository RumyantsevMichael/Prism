---
name: setup
description: "Set up, amend, or migrate Prism for a project by interviewing the person about project kind, stack and test command, shared store and workspace, components, tracker, and interaction, then writing `.prism/workflow.md`. Use when a project has no Prism configuration, when a Prism tool or skill reports a missing, placeholder, or earlier-version setting or record, or when the person adds a test, lint, or BDD tool or another repository."
sdm: "0.3"
---

# Set up Prism

Setup owns `.prism/workflow.md`: other skills report a change it needs, and setup asks the person and writes it, except that the slice whose design adds the test runner replaces `none yet` with the real `Test command`.
Configured paths resolve from the project root.

## 1. Choose the entry

- **Onboard** when `.prism/workflow.md` does not exist.
- **Migrate** when `.claude/workflow-config.md`, a hand-written roadmap without a roadmap record, or a Prism refusal names configuration or records from an earlier Prism.
- **Amend** when the person or another skill names a change, such as a new tool, a real test command for `none yet`, a missing `Repository` line, or another repository.

Onboarding covers every topic in the interview, while migration and amendment cover only the topics their change touches.

## 2. Interview the person

1. Read applicable project instructions, package manifests, the existing `.prism/workflow.md` or `.claude/workflow-config.md`, and common documentation paths, without reading application source.
2. Ask one topic per round, with each discovered value filled in and a recommended answer, so that the person mostly confirms.
3. Use the host's structured question tool when `Interaction style` is `structured` and the tool is available, and numbered options in the message otherwise, following the [workflow gate rules](../workflow/SKILL.md#supporting-procedures).
4. When you run as a child agent that cannot ask the person, return `BLOCKED` with each open topic as a [blocker](../workflow/SKILL.md#common-terms), and continue from the answers that the next run receives.

| Topic | What to settle |
| --- | --- |
| Project kind | Greenfield, with no source or tests yet, or brownfield; and whether the work spans several packages or repositories. |
| Stack | Languages, test command, BDD harness, typecheck, and lint or format command and whether it writes changes; a project with no tests yet uses `none yet` as its test command, never a no-op command. |
| Verification | How to exercise the product and prove a change, and the commands that write changes. |
| Workspace | Whether records live in a store shared with other checkouts or repositories; with a store, its `Store` location, this repository's `Repository` name, `Store sync`, and a workspace name. |
| Components | The packages the person declares as [components](../workflow/SKILL.md#common-terms), and for several repositories, the other repositories' components they depend on. |
| Tracker and commits | The tracker, its labels, commit scopes, and conventions; for GitHub, whether the repository has a GitHub remote and `gh` is available. |
| Interaction | `Interaction style`, `Review browser`, and `Session offer`. |
| Constraints | Project prohibitions and sign-off requirements. |
| Repository intelligence | `CodeNib command`: an absolute executable path when CodeNib is outside the Prism MCP process `PATH`, otherwise `n/a`. |

- When the topic is Components, call `get_roadmap` and read its `components`:
  - When `components.proposal` is present, show the person this [component proposal](../workflow/SKILL.md#common-terms): its `markdown` block, its `skipped` manifests, and, when present, its `problem`, the refusal the block meets until it changes.
  - When the person approves it, use its block, with the changes the person asks for, as the `## Components` section after `## Stack`.
  - When there is no proposal, declare as components only the packages the person agrees to, as in the components example.
- When the topic is Workspace and the person sets a workspace name, record it with `update_roadmap` and a `set_workspace_name` operation, and keep a name the store already has unless the person changes it, because every repository on the store shares it.

`Interaction style` defaults to `structured`, and `plain-text` presents the same choices as numbered options in the message body.
`Review browser` defaults to `auto`, selecting the internal browser on desktop and the system browser in CLI sessions; `internal` and `external` select those browsers explicitly.
`Session offer` defaults to `ask`, so a new conversation offers Prism for work that changes documented intent, and `off` stops the offer.
A missing BDD harness uses `none`, making feature files specification-only.

- Don't
  - Write a `## Components` block, `Store`, or `Repository` line that the person has not approved.

## 3. Write the configuration

1. When migrating `.claude/workflow-config.md`, convert project-root paths such as `/docs/ADRs/` to `docs/ADRs/` and keep other values without reinterpretation.
2. Write `.prism/workflow.md` with all sections below and the settled values, using `n/a` for unavailable values except the BDD harness value `none`.
3. Add `## Workspace` after `## Paths` only when the project uses a shared store.

```markdown
# Workflow config
<!-- Read by the workflow skills. Created by setup. -->

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
- Test command: <command, or none yet>
- BDD harness: <name and acceptance command, or none>
- Typecheck: <...>
- Lint/format: <command and whether it writes changes>

## Repository intelligence
- CodeNib command: n/a

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
- Session offer: ask

## Constraints
- <Project prohibitions and sign-off requirements.>
```

Components example:

```markdown
## Components
- billing: packages/billing
  - Test command: npm test
  - Depends on: shared, portal/site
- shared: packages/shared
- Shared paths: bun.lock
```

Each component is a lowercase name and its project-relative folder, optionally with its own test command, which runs in its folder, and its dependencies.
A dependency names a component of this repository, or another repository's component as `<repository>/<component>`.
Files outside every declared folder belong to the root component, which tests with the `Test command` under `## Stack`.
Any slice may change a file under a shared path.

Workspace example:

```markdown
## Workspace
- Store: git@github.com:you/prism-store.git
- Repository: api
- Store sync: on
```

## 4. Create missing documentation

1. Create missing configured documentation directories, including parent directories for configured files.
2. If the glossary is absent, create its title and one-line purpose.
3. If the roadmap record is absent and no legacy roadmap exists, create it by calling `update_roadmap` with `expectedRevision: null` and the product purpose as what the roadmap serves.
4. If a legacy roadmap or sibling `roadmap.puml` exists without a roadmap record:
   1. Map each legacy initiative to an identifier that matches its plans folder, its band, its required initiatives, its rationale, and its open questions.
   2. Map `shipped` and `superseded` initiatives to `ship` and `supersede` operations.
   3. Present the proposed record and every statement that does not map, and wait for user acceptance.
   4. Call `update_roadmap` with `expectedRevision: null`, the accepted operations, and `replace_hand_written_projection`.
5. Add a purpose README to each newly created requirements, ADR, feature, and user-guide directory.

Existing documentation remains unchanged.
Plans hold each slice's design document and recovery notes, with no seed file.

## 5. Report readiness

1. Report the changed paths and whether Prism can work in the project now: the test command is set, or `none yet` until the first slice adds a runner; a store answers `get_roadmap`; and, in Codex, the person must trust Prism's hooks through `/hooks` before gate answers and run totals work.
2. For a migration, explain that Prism no longer reads the legacy file and the person may remove it after review.
3. Point to `workflow`.

This skill does not commit its changes.
