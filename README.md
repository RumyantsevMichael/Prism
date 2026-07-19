<p align="center">
  <img src="assets/banner.png" alt="A prism refracting a beam of white light into a spectrum" width="640">
</p>

# prism

A spec-driven agentic engineering workflow for Claude Code — one beam of an idea in, an ordered spectrum of shippable tracks out.

Changes big enough to need a spec move through dedicated sessions over a layered spec — ADR, technical design, contracts, build plan, Gherkin feature files — each session a deliberate context boundary.
Small changes skip the flow entirely.

## The map

| Rung | Skill | Job |
|---|---|---|
| Priority | `prism:roadmap` | Order whole initiatives Now/Next/Later |
| Shaping *(optional)* | `prism:ideate` | Brainstorm a shapeless idea into Proposed ADR(s) — or kill it |
| Build order | `prism:plan` | Decompose a multi-ADR initiative into dependency-ordered tracks |
| Spec | `prism:design` | Per track: ADR ⇄ design → contracts + build plan + feature files → handoff |
| Build | `prism:implement` | Fresh session: validate the spec, tests first, implement to green |

`prism:orchestrate` chains plan → design → implement across tracks via fresh subagent sessions.
The `write-*` skills and `validate-artifacts` are sub-skills loaded inside sessions, never sessions of their own.
Defect repair sits outside the flow: diagnose and report against the settled spec before any fix.

Start with `prism:workflow` for the full picture — session discipline, cross-session lifecycles, and the durable-artifact rules.

## Install

In Claude Code:

```
/plugin marketplace add RumyantsevMichael/Prism
/plugin install prism@prism
```

Then, in each project, run `/prism:workflow-init` once — it inspects the project, interviews you, and writes `.claude/workflow-config.md` (doc paths, stack, verification, tracker, commit conventions).
Every prism skill reads that file first.

Without a config, skills fall back to the default layout: `/docs/ADRs/`, `/docs/plans/`, `/docs/Features/`, `/docs/roadmap.md`, `/docs/Glossary.md`, `/docs/user-guide/`.

### For a whole team

Commit this to a project's `.claude/settings.json` so collaborators get prism on clone:

```json
{
  "extraKnownMarketplaces": {
    "prism": { "source": { "source": "github", "repo": "RumyantsevMichael/Prism" } }
  },
  "enabledPlugins": { "prism@prism": true }
}
```

## Updating

```
/plugin marketplace update prism
/plugin update prism@prism
```

To stay on a fixed release instead of tracking `main`, add the marketplace at a tag: `/plugin marketplace add RumyantsevMichael/Prism@v0.1.0`.

Releases follow semantic versioning and are recorded in [CHANGELOG.md](CHANGELOG.md).
A major bump means a skill was renamed or removed, or that artifacts written by an earlier version need migrating - the changelog says which.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository layout, local development, validation, and the release process.

## License

[MIT](LICENSE)

