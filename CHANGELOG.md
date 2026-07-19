# Changelog

All notable changes to this plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because skills are prompts rather than code, versioning maps to behavior:

- **MAJOR** - a skill is removed or renamed, or its contract with the user changes
  in a way that breaks existing project setups (config keys, artifact paths, or
  file formats a prior version wrote).
- **MINOR** - a new skill, a new capability inside an existing skill, or a new
  optional config key.
- **PATCH** - wording, clarity, and bug fixes that leave the workflow's shape and
  artifacts unchanged.

## [Unreleased]

## [0.1.0] - 2026-07-19

### Added

- Session skills: `roadmap`, `ideate`, `plan`, `design`, `implement`, `orchestrate`.
- Authoring sub-skills: `write-adr`, `write-build-plan`, `write-contracts`,
  `write-feature`, `write-handoff`, `write-step-definitions`, `write-user-docs`.
- `validate-artifacts` for adversarial pre-code spec validation.
- `workflow` overview skill covering the session map, cross-session lifecycles,
  and durable-artifact rules.
- `workflow-init` to interview a project and write `.claude/workflow-config.md`.
- Plugin and marketplace manifests, so the repo installs as a Claude Code plugin.

[Unreleased]: https://github.com/RumyantsevMichael/Lux/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/RumyantsevMichael/Lux/releases/tag/v0.1.0
