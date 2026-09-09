# Changelog

## [0.7.0](https://github.com/RumyantsevMichael/Prism/compare/v0.6.0...v0.7.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* Child slice folders contain outcome records while orchestration owns map relationships. C4 diagrams live in slice folders, and findings remain authoritative in their review lanes.
* Remove write-handoff, write-build-plan, and validate-artifacts. Replace the prior track specification format with compact slice records.

### Added

* adopt code-centered slice delivery workflow ([63156ec](https://github.com/RumyantsevMichael/Prism/commit/63156ecc2cd2fbb40f8203f1d715bcc316db0118))
* adopt minimal recursive workflow skills ([3399dbe](https://github.com/RumyantsevMichael/Prism/commit/3399dbe87220c73a0526e46b945579b7503343bb))
* adopt simplified SDM skills ([a3498b4](https://github.com/RumyantsevMichael/Prism/commit/a3498b4961b5ef4dd1306d856d44c8b9487e148a))
* checkpoint slices around review phases ([e3b48f0](https://github.com/RumyantsevMichael/Prism/commit/e3b48f08a4ae8d00dd624b7ed3e74f427276ac8b))
* improve Prism orchestration and review ([a153730](https://github.com/RumyantsevMichael/Prism/commit/a153730c46f06bc9a37ae79349663e2fa104a665))
* let implementation reviews add regression probes ([7c63db8](https://github.com/RumyantsevMichael/Prism/commit/7c63db833775960f3c0397b305dad31dce5cf082))
* preserve executable design artifacts after fit ([cb57dae](https://github.com/RumyantsevMichael/Prism/commit/cb57dae034b5d6163f5dfac57f08272ca999517e))
* refine orchestration operations and child supervision ([fc539be](https://github.com/RumyantsevMichael/Prism/commit/fc539bed022c4e745867e500c6bb7c559ba62bd9))
* simplify orchestration state ([348c18d](https://github.com/RumyantsevMichael/Prism/commit/348c18dcbaf509b7ffd90aa9a6f8c06ecdfb4b3c))
* slim workflow skill and unify review flow ([79ae2ac](https://github.com/RumyantsevMichael/Prism/commit/79ae2acad520f734658e509657bdd4d845d3d288))


### Fixed

* align skills with SDM workflow rules ([d278646](https://github.com/RumyantsevMichael/Prism/commit/d278646e912fdca8cc15aa8610ddfccae26cd52d))
* **review:** scope high-risk review lanes ([6bbac7d](https://github.com/RumyantsevMichael/Prism/commit/6bbac7d4a8ae21b0d8bbe732a800935fe6238f66))
* **workflow:** add design audits and exhaustive review gates ([7cac3e6](https://github.com/RumyantsevMichael/Prism/commit/7cac3e6007e4fb8b1c6981529c7916c08bb86b88))
* **workflow:** add explicit model routing policy ([0225763](https://github.com/RumyantsevMichael/Prism/commit/022576314bbe8b3d9fb19b1cb62101386f37fc40))
* **workflow:** batch artifact review and streamline verification ([5dc1053](https://github.com/RumyantsevMichael/Prism/commit/5dc10537ed86ef4696a6d56c128b0533ccfa3345))

## [0.6.0](https://github.com/RumyantsevMichael/Prism/compare/v0.5.2...v0.6.0) (2026-08-13)


### Added

* decouple design tracks from implementation tasks ([b7be329](https://github.com/RumyantsevMichael/Prism/commit/b7be3291c6c6b7f3cfd22eacbc404dba257a65e4))


### Fixed

* improve artifact review navigation and gates ([d240c12](https://github.com/RumyantsevMichael/Prism/commit/d240c122f6178fb04da377edc1860addbe83057c))

## [0.5.2](https://github.com/RumyantsevMichael/Prism/compare/v0.5.1...v0.5.2) (2026-08-12)


### Fixed

* use consumer root for review server ([559f661](https://github.com/RumyantsevMichael/Prism/commit/559f661323ba3ced818ee733c99073d926dab733))

## [0.5.1](https://github.com/RumyantsevMichael/Prism/compare/v0.5.0...v0.5.1) (2026-08-12)


### Fixed

* use consumer root for review server ([43e0c61](https://github.com/RumyantsevMichael/Prism/commit/43e0c610ae3d37483e74e35dd0df8e2b6faa9fc4))

## [0.5.0](https://github.com/RumyantsevMichael/Prism/compare/v0.4.0...v0.5.0) (2026-08-12)


### Added

* add PlantUML artifact review workflow ([22ec0b0](https://github.com/RumyantsevMichael/Prism/commit/22ec0b0819a00b9e8666f6effed7c4b3d7c2364d))
* polish artifact review interface ([c54515f](https://github.com/RumyantsevMichael/Prism/commit/c54515f310a3cd503f8e8a223334f0c5ee3392fb))

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
