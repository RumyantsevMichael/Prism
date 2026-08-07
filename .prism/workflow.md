# Workflow config
<!-- Read by the workflow skills. -->

## Product
- Name: prism
- One-line description: A spec-driven engineering workflow plugin for Claude Code and Codex.

## Paths
- ADRs: docs/ADRs/
- Plans (scratch): docs/plans/
- Feature files: docs/Features/
- Roadmap: docs/roadmap.md
- Glossary: docs/Glossary.md
- User guide: docs/user-guide/
- Product strategy: n/a

## Stack
- Languages: Markdown prompts and Python benchmark tooling
- Test command: python3 bench/harness/bench.py selfcheck
- BDD harness: none
- Typecheck: n/a
- Lint/format: n/a

## Verification
- Run the Claude validator, the Codex package smoke test, and the benchmark selfcheck.

## Tracker
- System: GitHub issues
- Labels: n/a

## Commits
- Scopes: free-form
- Notes: Changes under skills use feat or fix, never docs.

## Interaction
- Interaction style: structured

## Constraints
- Keep one sentence per line in Markdown files.
- Do not edit CHANGELOG.md manually.
- Do not bump plugin versions manually.
