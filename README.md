# lux

A spec-driven agentic engineering workflow for Claude Code — one beam of an idea in, an ordered spectrum of shippable tracks out.

Changes big enough to need a spec move through dedicated sessions over a layered spec — ADR, technical design, contracts, build plan, Gherkin feature files — each session a deliberate context boundary. Small changes skip the flow entirely.

## The map

| Rung | Skill | Job |
|---|---|---|
| Priority | `lux:roadmap` | Order whole initiatives Now/Next/Later |
| Shaping *(optional)* | `lux:ideate` | Brainstorm a shapeless idea into Proposed ADR(s) — or kill it |
| Build order | `lux:plan` | Decompose a multi-ADR initiative into dependency-ordered tracks |
| Spec | `lux:design` | Per track: ADR ⇄ design → contracts + build plan + feature files → handoff |
| Build | `lux:implement` | Fresh session: validate the spec, tests first, implement to green |

`lux:orchestrate` chains plan → design → implement across tracks via fresh subagent sessions. The `write-*` skills and `validate-artifacts` are sub-skills loaded inside sessions, never sessions of their own. Defect repair sits outside the flow: diagnose and report against the settled spec before any fix.

Start with `lux:workflow` for the full picture — session discipline, cross-session lifecycles, and the durable-artifact rules.

## Install

In Claude Code:

```
/plugin marketplace add RumyantsevMichael/Lux
/plugin install lux@lux
```

Then, in each project, run `/lux:workflow-init` once — it inspects the project, interviews you, and writes `.claude/workflow-config.md` (doc paths, stack, verification, tracker, commit conventions). Every lux skill reads that file first.

Without a config, skills fall back to the default layout: `/docs/ADRs/`, `/docs/plans/`, `/docs/Features/`, `/docs/roadmap.md`, `/docs/Glossary.md`, `/docs/user-guide/`.

To pin a release instead of tracking `main`, add the marketplace at a tag: `/plugin marketplace add RumyantsevMichael/Lux@v0.1.0`. Update later with `/plugin marketplace update lux` followed by `/plugin update lux@lux`.

### Team-wide

Commit this to a project's `.claude/settings.json` so collaborators get lux on clone:

```json
{
  "extraKnownMarketplaces": {
    "lux": { "source": { "source": "github", "repo": "RumyantsevMichael/Lux" } }
  },
  "enabledPlugins": { "lux@lux": true }
}
```

### Local development

Work on the plugin against a live session with `claude --plugin-dir path/to/lux`, and check the manifests with `claude plugin validate . --strict`.

## Versioning

Semantic versioning, with releases tagged and recorded in [CHANGELOG.md](CHANGELOG.md). Since skills are prompts, MAJOR means a skill was removed or renamed or its artifacts/config changed incompatibly; MINOR means new skills or capabilities; PATCH means clarity and correctness fixes that leave the workflow's shape intact.

## License

[MIT](LICENSE)
