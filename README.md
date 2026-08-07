<p align="center">
  <img src="assets/banner.png" alt="A prism refracting a beam of white light into a spectrum" width="640">
</p>

# Prism

Prism helps Claude Code and Codex plan complex changes before they write code.
It records decisions as project files that each new agent context can review and challenge.
Small changes do not need this workflow.

Use Prism when a change needs architecture decisions, defined behavior, several implementation tracks, or a clear handoff between planning and coding.

## Install

### Claude Code

Run these commands in Claude Code:

```text
/plugin marketplace add RumyantsevMichael/Prism
/plugin install prism@prism
```

### Codex

Prism requires Codex 0.147.0 or later.

```bash
codex plugin marketplace add RumyantsevMichael/Prism
codex plugin add prism@prism
```

## Start a project

Initialize Prism once in each project.

- In Claude Code, run `/prism:workflow-init`.
- In Codex, select `prism:workflow-init` from the skill picker or mention it in your request.

The skill inspects the project and asks about its documentation paths, stack, verification commands, issue tracker, and local rules.
It then writes `.prism/workflow.md` and creates the configured documentation structure.

Open a fresh task and start the workflow that fits your change.

| Starting point | Skill | Use it when |
|---|---|---|
| An unformed idea | `prism:ideate` | You need to explore the problem and possible decisions |
| A settled initiative | `prism:plan` | You need to split several decisions into ordered implementation tracks |
| One defined feature | `prism:design` | You need a technical design and an implementation specification |
| An approved specification | `prism:implement` | You are ready to write tests and code |
| A full initiative | `prism:orchestrate` | You want Prism to coordinate planning, design, and implementation |

Use `prism:workflow` when you need an explanation of the complete workflow.

## How the workflow works

Prism separates product decisions from implementation work.
Each main stage uses a fresh context so the next stage must understand the saved specification without hidden conversation history.

| Stage | Skill | Result |
|---|---|---|
| Prioritize | `prism:roadmap` | An ordered Now, Next, and Later roadmap |
| Shape | `prism:ideate` | Proposed architecture decision records, or a decision to stop |
| Plan | `prism:plan` | Dependency-ordered implementation tracks |
| Design | `prism:design` | A technical design, contracts, feature files, build plan, and handoff |
| Implement | `prism:implement` | Tested code that follows the approved specification |

`prism:orchestrate` connects the Plan, Design, and Implement stages through fresh child-agent contexts.
It can run independent tracks in parallel when the host provides isolated workspaces.
Otherwise, it runs each track in sequence.

The `write-*` skills create individual specification files.
The `validate-artifacts` skill reviews a specification from an isolated context before implementation starts.

Defect repair stays outside this workflow.
First reproduce and diagnose a defect against the existing specification.
Change the specification only when the required behavior must also change.

## Project files

Prism stores its configuration in `.prism/workflow.md`.
All configured paths resolve from the project root.

The default paths are:

| Content | Default path |
|---|---|
| Architecture decisions | `docs/ADRs/` |
| Temporary plans and handoffs | `docs/plans/` |
| Gherkin feature files | `docs/Features/` |
| Roadmap | `docs/roadmap.md` |
| Glossary | `docs/Glossary.md` |
| User documentation | `docs/user-guide/` |

### Migrate an older configuration

Prism no longer reads `.claude/workflow-config.md` during normal tasks.
Run `prism:workflow-init` to migrate its values into `.prism/workflow.md`.
The migration keeps the old file unchanged.

## Update

### Claude Code

```text
/plugin marketplace update prism
/plugin update prism@prism
```

### Codex

```bash
codex plugin marketplace upgrade prism
```

Releases follow semantic versioning and appear in [CHANGELOG.md](CHANGELOG.md).
Before version 1.0, a minor release can include a breaking workflow or artifact migration.

## Configure Claude Code for a team

Commit this configuration to `.claude/settings.json` so Claude Code can discover and enable Prism for the project.

```json
{
  "extraKnownMarketplaces": {
    "prism": {
      "source": {
        "source": "github",
        "repo": "RumyantsevMichael/Prism"
      }
    }
  },
  "enabledPlugins": {
    "prism@prism": true
  }
}
```

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the repository layout, local development process, validation steps, and release process.

## License

Prism uses the [MIT License](LICENSE).
