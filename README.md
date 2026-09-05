<p align="center">
  <img src="assets/banner.png" alt="A prism refracting a beam of white light into a spectrum" width="640">
</p>

# Prism

Prism helps Claude Code and Codex deliver complex changes as small outcome slices.
It keeps one delivery context from code exploration through implementation.
Fresh contexts audit the design and review completed code.
Small changes do not need this workflow.

Use Prism when a change needs clear intent, architecture decisions, durable behavior records, or several dependency-ordered slices.

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

Start with `prism:ideate` to shape an idea, or `prism:orchestrate` for a roadmap initiative with Approved requirement links.
Use `prism:design` directly for one Approved outcome.
Use `prism:workflow` for workflow guidance.

## How the workflow works

| Stage | Skill | Result |
|---|---|---|
| Prioritize | `prism:roadmap` | An ordered Now, Next, and Later roadmap |
| Shape | `prism:ideate` | Approved EARS requirement files, or a decision to stop |
| Start an initiative | `prism:orchestrate` | One provisional root slice and a short resume note |
| Design | `prism:design` | A fit decision, Gherkin acceptance scenarios, architectural ADRs, and executable boundary artifacts when needed |
| Map accepted state | `prism:write-map` | An authoritative `map.puml` with accepted topology and structural statuses |
| Design audit | `prism:review` in `design-audit` mode | Complete requirements, boundary, contract, security, and verification findings |
| Implement | `prism:implement` | Failing tests, working code, step definitions, and verification |
| Review | `prism:review` in `implementation-review` mode | Exhaustive independent findings against the completed code and intent until `CLEAN` |

The roadmap owns the initiative name, intent, priority, and Approved requirement links.
The orchestrator creates one provisional root slice after those inputs exist.
Design explores documents and focused code paths, then returns `FIT`, `SPLIT`, or `BLOCKED`.
On `SPLIT`, design proposes child slices and dependencies while preserving requirement coverage.
The orchestrator applies the accepted proposal and runs `write-map`, then repeats design for each child.
It routes decisions while design owns boundaries, dependencies, and architecture.

Each fitted leaf proceeds through design audit, implementation, review, and user correctness confirmation.
Design discovery can precede dependency implementation, but implementation requires completed dependencies and a fresh fit check.
Review repeats after corrections until `CLEAN`, a user stop, or a real blocker.
After integration, delivery verifies the result, with fresh review and confirmation when behavior changes or equivalence is uncertain.

The [resume note](skills/orchestrate/SKILL.md#6-resume-note) records settings, active work, pending decisions, next actions, and evidence paths.
The authoritative [map](skills/write-map/references/map-format.md) records slice topology, titles, requirement assignments, dependencies, and structural status.
A bundled validator checks the constrained map grammar, coverage, and expanded dependency graph.
Slice files retain findings and evidence needed to resume work.
Agents reason about the next step within the workflow's ownership rules and human gates.

Design creates new artifacts only after fit passes.
Requirements preserve intent, ADRs preserve decisions, and feature files preserve acceptance examples.
Tests and consumed contracts enforce behavior, diagrams explain structure, and code supplies implementation details.
The focused `write-requirements` and `write-map` skills support file authoring and accepted map changes.

## Review artifacts visually

Prism stores diagrams as PlantUML `.puml` source files beside their Markdown artifacts.
Agents read the PlantUML source and never read rendered images.
The bundled review server renders diagrams in the human's browser without creating image files.

Prism opens one viewer session after design audit and before final correctness confirmation.
The artifact tree shows all files, and tabs retain open artifacts.
Ask the agent to open the viewer at any time during an active session.

`Review browser: auto` uses the internal browser in desktop sessions and the system browser in CLI sessions.
Set `internal` or `external` in `.prism/workflow.md` to override this choice.
When the selected browser is unavailable, Prism presents the URL and source artifacts.

Start a standalone review from a Prism checkout when no harness session is active:

```bash
./bin/prism review
./bin/prism review docs/roadmap.md
```

The review server creates a local Prism certificate authority and a separate server certificate.
Trust the authority once in your login keychain when Prism prints its command, then restart the browser.
Prism does not install the authority automatically or change the system keychain.

The standalone `prism review` command always opens the system browser.

The server binds to `127.0.0.1`, selects an available port, and uses an unguessable session URL.
It renders entirely in the browser and does not send project sources to a remote renderer.
Stop the command with `Ctrl-C` when the review ends.

Defect repair stays outside this workflow.
First reproduce and diagnose a defect against the existing specification.
Change the specification only when the required behavior must also change.

## Project files

Prism stores its configuration in `.prism/workflow.md`.
All configured paths resolve from the project root.

The default paths are:

| Content | Default path |
|---|---|
| EARS requirements | `docs/requirements/` |
| Architecture decisions | `docs/ADRs/` |
| Initiative plans, state, slice findings, and recovery records | `docs/plans/` |
| Gherkin feature files | `docs/Features/` |
| Roadmap | `docs/roadmap.md` |
| Glossary | `docs/Glossary.md` |
| User documentation | `docs/user-guide/` |

Each initiative coordination directory has a `map.puml` file beside `state.json`.
The `write-map` skill applies accepted design proposals and structural lifecycle changes to the map.
The map shows meaningful slice titles, nested parent-child slices, dependency edges, and live status.
Design supplies titles such as `Download signed reports`, while stable slugs identify slices and artifact paths.

### Migrate an older initiative map

On resume, Prism preserves legacy coordination files before converting their explicit topology to the constrained map format.
It keeps needed evidence and records current work in the short `state.json` resume note.
Missing or conflicting facts require recovery before scheduling.

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
Read the [Skill Definition Markdown authoring standard](docs/skill-language.md) and its [validation behavior](docs/skill-language-validation.md) before you edit a skill.

## License

Prism uses the [MIT License](LICENSE).
Prism includes the MIT build of PlantUML for local browser rendering.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for its version and source.
