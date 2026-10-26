<p align="center">
  <img src="assets/banner.png" alt="A prism refracting a beam of white light into a spectrum" width="640">
</p>

# Prism

Prism is a Claude Code and Codex plugin for big, multi-file changes.
It designs each slice of a feature as a frozen contract with failing acceptance tests, has fresh agents implement against them, and runs your tests before a slice counts as done.

Prism is built for complex features in large codebases.
For a change that fits in one session, plain Claude Code or Codex is faster and cheaper.

## Highlights

- **Frozen contracts.** Design fixes the observable interface, probes its assumptions against the real system, and writes acceptance tests that implementers may not change.
- **Verified completion.** Prism runs your configured test command itself, after you allow it once, and a slice is done only on a fresh passing run.
- **Review where it pays.** Design marks risky slices, such as security-heavy ones, for an independent review in a fresh context.
- **Local semantic search.** A bundled index searches code and docs by meaning, on your machine, with nothing else to install.
- **Review browser.** Roadmap board, slice graphs, rendered PlantUML diagrams, change maps, and review findings on `127.0.0.1`.
- **Answer in the browser.** Questions for you wait on one Attention page, and in Claude Code the agent resumes when you answer.
- **Durable records.** Requirements in EARS, decisions as ADRs, and acceptance behavior as Gherkin.
- **Refactoring analysis.** Find duplicated logic, repeated values, diverged copies, and oversized classes and functions.

## Install

Prism runs on macOS and Linux (x64 and arm64) and Windows (x64).

**Claude Code**

```text
/plugin marketplace add RumyantsevMichael/Prism
/plugin install prism@prism
```

**Codex** 0.147.0 or later

```bash
codex plugin marketplace add RumyantsevMichael/Prism
codex plugin add prism@prism
```

In Codex, trust the Prism hooks through `/hooks`, then start a new task.

The first code analysis downloads a pinned runtime and model from Prism's GitHub release, so a restricted network only needs `github.com`.

## Quick start

1. Run `/prism:workflow-init` once per project to write `.prism/workflow.md`.
2. Start an initiative:

   ```text
   /prism:orchestrate Let users download signed PDF reports from the billing page
   ```

3. Review and answer questions in the browser that opens.

In Codex, pick the same skills from the skill picker or mention them in your request.

## Skills

| Skill | Use it to |
|---|---|
| `prism:orchestrate` | Run or resume an initiative from idea to verified code |
| `prism:ideate` | Shape an idea into Approved requirements and a roadmap entry |
| `prism:design` | Design one slice: a frozen contract and failing acceptance tests, or a split |
| `prism:refactor` | Analyze or simplify existing code, skills, documents, or configuration |
| `prism:workflow` | Explain the workflow |

## Learn more

- [Workflow](docs/user-guide/workflow.md): stages, slices, records, autonomy, and project files.
- [Review browser](docs/user-guide/review-browser.md): navigation, search, answering questions, and several projects.
- [Repository intelligence](docs/user-guide/repository-intelligence.md): search, analysis tools, providers, and fit checks.
- [Artifact conservation](docs/user-guide/artifact-conservation.md): how review checks planned changes against the source.
- [Refactoring](docs/user-guide/refactoring.md) and [Decision history](docs/user-guide/decision-history.md).

## Update

```text
/plugin marketplace update prism
/plugin update prism@prism
```

In Codex, run `codex plugin marketplace upgrade prism`, review changed hooks through `/hooks`, and start a new task.

Changes are listed in [CHANGELOG.md](CHANGELOG.md).
Before 1.0, a minor release can include a breaking migration, and [Upgrading to managed records](docs/user-guide/upgrading-to-managed-records.md) covers the one in 0.10.0.

## Enable Prism for a team

Commit this to `.claude/settings.json` so Claude Code offers Prism to everyone in the project:

```json
{
  "extraKnownMarketplaces": {
    "prism": {
      "source": { "source": "github", "repo": "RumyantsevMichael/Prism" }
    }
  },
  "enabledPlugins": { "prism@prism": true }
}
```

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).
Prism bundles the MIT build of PlantUML, described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
