# Changelog

## [0.4.0](https://github.com/RumyantsevMichael/Prism/compare/v0.3.0...v0.4.0) (2026-08-11)


### Added

* replace ideation ADRs with EARS requirements ([b081658](https://github.com/RumyantsevMichael/Prism/commit/b0816585f845258c0eb01ca924bd4ec19107a168))


### Documentation

* rewrite README for Codex support ([c3ab537](https://github.com/RumyantsevMichael/Prism/commit/c3ab53749d68c2c0dc322786d7555ad7be0fb54d))

## [0.3.0](https://github.com/RumyantsevMichael/Prism/compare/v0.2.0...v0.3.0) (2026-08-07)


### ⚠ BREAKING CHANGES

* add native Codex support and portable workflow

### Added

* add native Codex support and portable workflow ([1509b17](https://github.com/RumyantsevMichael/Prism/commit/1509b177524eaabc577c53f595f5f9b656b6f304))
* fork drafters, isolate validation, and loop design until the spec holds ([91f009b](https://github.com/RumyantsevMichael/Prism/commit/91f009b9274848d3924b0cae8c25d0dbe9b64d6e))
* merge the fork-drafters validation loop into main ([5a49aec](https://github.com/RumyantsevMichael/Prism/commit/5a49aec26b520398fd078d34975c3526f6d88421))
* single validation pass, unblocked ADR acceptance, recorded OPEN resolutions ([681c28b](https://github.com/RumyantsevMichael/Prism/commit/681c28b4482fd72781cc13d6dc0a24f9015a6bf2))


### Fixed

* normalize skill prose to one sentence per line and plain dashes ([8ea966a](https://github.com/RumyantsevMichael/Prism/commit/8ea966a4a4dfc6e2d879d776e549bd5c1c9f2cd0))
* normalize skill prose to one sentence per line and plain dashes ([f919db6](https://github.com/RumyantsevMichael/Prism/commit/f919db6c6469002f4f54f10a6ef2995bfb671003))
* omit local paths from benchmark records ([e6802e4](https://github.com/RumyantsevMichael/Prism/commit/e6802e45d4c12f6b28d3341ec7ad112b95d82ca0))


### Documentation

* point CONTRIBUTING at the benchmark ([753a15f](https://github.com/RumyantsevMichael/Prism/commit/753a15f400904a4614d83089083d3bf6c8debffb))
* point CONTRIBUTING at the benchmark ([d0dc550](https://github.com/RumyantsevMichael/Prism/commit/d0dc550e8e9ea9bd503a8b27c131ca21541b6b8b))

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
