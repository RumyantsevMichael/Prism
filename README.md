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

Start the workflow that fits your change.

| Starting point | Skill | Use it when |
|---|---|---|
| An unformed idea | `prism:ideate` | You need to explore the problem and define product requirements |
| A defined capability | `prism:write-requirements` | You need to record and approve EARS requirements without broad ideation |
| Approved requirements with several outcomes | `prism:plan` | You need dependency-ordered outcome slices |
| One Approved outcome | `prism:design` | You need to explore the code and confirm that the outcome fits one context |
| A fitted outcome | `prism:review` in `design-audit` mode | You need to audit the design before implementation |
| An audited outcome | `prism:implement` | The same delivery context is ready to write tests and code |
| A full initiative | `prism:orchestrate` | You want Prism to coordinate planning, design audit, implementation, and review |

Use `prism:workflow` when you need an explanation of the complete workflow.

## How the workflow works

Prism separates durable product intent from code delivery.
The orchestrator keeps one delivery context from design through implementation.
The design audit and final review require fresh contexts.

| Stage | Skill | Result |
|---|---|---|
| Prioritize | `prism:roadmap` | An ordered Now, Next, and Later roadmap |
| Shape | `prism:ideate` | Approved EARS requirement files, or a decision to stop |
| Plan | `prism:plan` | Dependency-ordered outcome slices |
| Design | `prism:design` | A fit decision and any consequential ADR proposal |
| Design audit | `prism:review` in `design-audit` mode | Complete requirements, boundary, contract, security, and verification findings |
| Implement | `prism:implement` | Failing tests, working code, durable behavior records, and verification |
| Review | `prism:review` in `implementation-review` mode | Exhaustive independent findings against the completed code and intent until `CLEAN` |

`prism:orchestrate` connects Plan, Design, Design audit, Implement, and Review through resumable child-agent contexts.
It resumes the same delivery agent from design through implementation.
It starts a fresh design review after `FIT` and a fresh implementation review after the code works.
It repeats each audit or review after corrections until the result is `CLEAN`, the user stops, or a real blocker occurs.
It can replace a delivery context from the current code and findings when a review reopens a defect.
The initiative plan stores a current `state.md` snapshot so a later orchestrator can resume after a phase boundary.
Each slice stores all design-audit and implementation-review findings in one `findings.md` file with correction and verification statuses.

One slice contains one observable outcome, one dominant path, one acceptance suite, and one reviewable diff.
The capability agent splits the slice after exploration when it cannot safely finish the outcome in one context.

Prism keeps requirements for intent and ADRs for consequential decisions.
It keeps tests and feature files for behavior.
It keeps diagrams for the implemented structure.
Code specifies implementation details.
Executable contracts exist only when code or verification consumes them.
Each declared contract records its canonical path, consumers, and exact verification command.
Each `NO CONTRACT NEEDED` result records a specific reason.

## Review artifacts visually

Prism stores diagrams as PlantUML `.puml` source files beside their Markdown artifacts.
Agents read the PlantUML source and never read rendered images.
The bundled review server renders diagrams in the human's browser without creating image files.

The orchestrator opens one Prism artifact viewer session for all recorded design artifacts after a clean design audit and for all changed artifacts before the final correctness gate.
The viewer's artifact tree contains the complete set, so the orchestrator does not open one viewer session per artifact.
The orchestrator must call a browser-opening capability for the selected browser.
Showing a URL without opening the viewer is only a fallback when no browser capability exists.
Ask the agent to open the Prism review page at any other time during an active harness session.

`Review browser` defaults to `auto` in `.prism/workflow.md`.
Auto review uses the internal browser in desktop sessions and the system browser in CLI sessions.
Internal review opens the URL in the internal browser when that browser is available.
Explicit `internal` and `external` values override `auto`.
If the selected browser is not available, Prism presents the URL and source artifacts.
Set `Review browser: external` to open review pages in the system browser.

Start a standalone review from a Prism checkout when no harness session is active:

```bash
./bin/prism review
./bin/prism review docs/roadmap.md
```

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
Prism includes the MIT build of PlantUML for local browser rendering.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for its version and source.
