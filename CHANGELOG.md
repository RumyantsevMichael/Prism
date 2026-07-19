# Changelog

## [0.2.0](https://github.com/RumyantsevMichael/Prism/compare/v0.1.0...v0.2.0) (2026-07-19)


### ⚠ BREAKING CHANGES

* the skill namespace changes from lux: to prism:, so /lux:design is now /prism:design. The marketplace and plugin are both renamed, which invalidates existing enabledPlugins keys. Done before first publish, so no installed users are affected.

### Added

* rename plugin from lux to prism ([e0d4345](https://github.com/RumyantsevMichael/Prism/commit/e0d43450448ced011dedd58d202fe69b33f85480))


### Documentation

* add prism banner to the README header ([8eeb1a4](https://github.com/RumyantsevMichael/Prism/commit/8eeb1a497210e0e19a2ff076b2c94f75446c396b))
* make CHANGELOG a generated artifact ([1efa276](https://github.com/RumyantsevMichael/Prism/commit/1efa27606801a20be5cbb507344f79c47c5e5709))

## [0.1.0] - 2026-07-19

### Added

- Session skills: `roadmap`, `ideate`, `plan`, `design`, `implement`, `orchestrate`.
- Authoring sub-skills: `write-adr`, `write-build-plan`, `write-contracts`, `write-feature`, `write-handoff`, `write-step-definitions`, `write-user-docs`.
- `validate-artifacts` for adversarial pre-code spec validation.
- `workflow` overview skill covering the session map, cross-session lifecycles, and durable-artifact rules.
- `workflow-init` to interview a project and write `.claude/workflow-config.md`.
- Plugin and marketplace manifests, so the repo installs as a Claude Code plugin.

[0.1.0]: https://github.com/RumyantsevMichael/Prism/releases/tag/v0.1.0
