# Workflow config
<!-- Read by the workflow skills. -->

## Product
- Name: prism
- One-line description: A spec-driven engineering workflow plugin for Claude Code and Codex.

## Paths
- Requirements: docs/requirements/
- ADRs: docs/ADRs/
- Plans: docs/plans/
- Feature files: docs/Features/
- Roadmap: docs/roadmap.md
- Glossary: docs/Glossary.md
- User guide: docs/user-guide/
- Product strategy: n/a

## Workspace
- Store: https://github.com/RumyantsevMichael/prism-state.git
- Repository: prism

## Stack
- Languages: Markdown prompts and TypeScript
- Test command: npm test
- BDD harness: none
- Typecheck: n/a
- Lint/format: n/a

## Verification
- Run the server tests, the Claude validator, and the Codex package smoke test.

## Tracker
- System: GitHub issues
- Labels: n/a

## Commits
- Scopes: free-form
- Notes: Changes under skills use feat or fix, never docs.

## Interaction
- Interaction style: structured
- Review browser: auto

## Constraints
- Keep one sentence per line in Markdown files.
- Do not edit CHANGELOG.md manually.
- Do not bump plugin versions manually.
