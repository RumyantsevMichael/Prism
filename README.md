<p align="center">
  <img src="assets/banner.png" alt="A prism refracting a beam of white light into a spectrum" width="640">
</p>

# prism

A spec-driven agentic engineering workflow for Claude Code and Codex.

Changes big enough to need a specification move through fresh contexts over a layered specification.
The layers are ADRs, technical design, contracts, a build plan, and Gherkin feature files.
Small changes skip the flow entirely.

## The map

| Rung | Skill | Job |
|---|---|---|
| Priority | `prism:roadmap` | Order whole initiatives Now/Next/Later |
| Shaping *(optional)* | `prism:ideate` | Brainstorm a shapeless idea into Proposed ADRs or reject it |
| Build order | `prism:plan` | Decompose a multi-ADR initiative into dependency-ordered tracks |
| Spec | `prism:design` | Per track: ADR ⇄ design → contracts + build plan + feature files → handoff |
| Build | `prism:implement` | Read the validated spec cold, write tests first, and implement to green |

`prism:orchestrate` chains plan → design → implement across tracks through fresh child-agent contexts.
It uses parallel isolated workspaces when available and safe sequential execution otherwise.
The `write-*` skills and `validate-artifacts` support those workflow tasks.
Defect repair sits outside the flow: diagnose and report against the settled spec before any fix.

Start with `prism:workflow` for context discipline, artifact lifecycles, and host capability fallbacks.

## Install

### Claude Code

```
/plugin marketplace add RumyantsevMichael/Prism
/plugin install prism@prism
```

Run `/prism:workflow-init` once in each project.
It inspects the project and writes `.prism/workflow.md`.

### Codex

Codex `0.147.0` or later can install Prism from its native package.

```bash
codex plugin marketplace add RumyantsevMichael/Prism
codex plugin add prism@prism
```

Invoke `prism:workflow-init` through the Codex skill picker or an explicit skill mention.
The skill writes the same `.prism/workflow.md` file used by Claude Code.

All configured paths resolve from the project root.
The default paths include `docs/ADRs/`, `docs/plans/`, `docs/Features/`, `docs/roadmap.md`, `docs/Glossary.md`, and `docs/user-guide/`.

### Configuration migration

Prism no longer reads `.claude/workflow-config.md` during normal workflow tasks.
Run `workflow-init` to migrate that file into `.prism/workflow.md`.
The migration preserves values, converts project-root paths to relative paths, and leaves the old file unchanged.

### For a whole team

Claude Code teams can commit this to `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "prism": { "source": { "source": "github", "repo": "RumyantsevMichael/Prism" } }
  },
  "enabledPlugins": { "prism@prism": true }
}
```

## Updating

Claude Code:

```
/plugin marketplace update prism
/plugin update prism@prism
```

Codex:

```bash
codex plugin marketplace upgrade prism
```

To stay on a fixed Claude release, add the marketplace at a release tag.

Releases follow semantic versioning and are recorded in [CHANGELOG.md](CHANGELOG.md).
Before version 1.0, a minor bump can contain a breaking workflow or artifact migration.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository layout, local development, validation, and the release process.

## License

[MIT](LICENSE)
