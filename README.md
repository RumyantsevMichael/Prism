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

## Setup

1. Place this plugin at `~/.claude/skills/lux/` (it auto-loads as `lux@skills-dir`; no install needed) or load it with `claude --plugin-dir path/to/lux`.
2. In each project, run `/lux:workflow-init` once — it inspects the project, interviews you, and writes `.claude/workflow-config.md` (doc paths, stack, verification, tracker, commit conventions). Every lux skill reads that file first.

Without a config, skills fall back to the default layout: `/docs/ADRs/`, `/docs/plans/`, `/docs/Features/`, `/docs/roadmap.md`, `/docs/Glossary.md`, `/docs/user-guide/`.
