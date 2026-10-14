# Changelog

## [0.10.0](https://github.com/RumyantsevMichael/Prism/compare/v0.9.0...v0.10.0) (2026-10-14)


### ⚠ BREAKING CHANGES

* map.puml and roadmap.puml are no longer read; initiatives use initiative.json and the roadmap uses roadmap.json, both managed through MCP tools, and the write-map skill no longer exists.

### Added

* act on user gate answers recorded in the review browser ([25718bd](https://github.com/RumyantsevMichael/Prism/commit/25718bd598b151291c203817278ce69e86cc69e2))
* add agent tabs from get_review_url instead of replacing them ([a65bdbc](https://github.com/RumyantsevMichael/Prism/commit/a65bdbc32380ef81a76e90d3c035a4d017dc61ee))
* add repository analysis tools and duplication gates for concept deltas ([e5acca0](https://github.com/RumyantsevMichael/Prism/commit/e5acca079c886490bc5cd177f56a2f535313fa4a))
* answer user gates from the review browser ([e383613](https://github.com/RumyantsevMichael/Prism/commit/e383613bb4518ae7dddf892b5b27f55a6fc8c309))
* drive roadmap and initiative changes through managed records ([0ecda5d](https://github.com/RumyantsevMichael/Prism/commit/0ecda5dd24cc1ef229203f63e9e989cd3ba3557a))
* find same-name units and report complex units ([bc18fe9](https://github.com/RumyantsevMichael/Prism/commit/bc18fe94044e61186f781a858ee39a093af7af8b))
* index repository units as a tree with structural fragments ([804c026](https://github.com/RumyantsevMichael/Prism/commit/804c026b40eb536589a8bf378bc75f089d6eb779))
* manage roadmap and initiative records through MCP tools ([633624f](https://github.com/RumyantsevMichael/Prism/commit/633624fd5921fa98d4da87107eb649e34803d3aa))
* move members that import an owned constant list out of shared literal groups ([85d2ca6](https://github.com/RumyantsevMichael/Prism/commit/85d2ca62d6f803bf31a71ac3e04f03b527dcedd6))
* navigate the review browser by places, scoped trees, and preview tabs ([a11ee79](https://github.com/RumyantsevMichael/Prism/commit/a11ee79d235b2ceaee2c0fe84c3bf7fbf30704ee))
* navigate the review browser by roadmap, initiative, and slice ([21ecc7b](https://github.com/RumyantsevMichael/Prism/commit/21ecc7bfdb8021a238e029f8298efc8c54253f67))
* record orchestrator user gates while they wait on the user ([6c62e2d](https://github.com/RumyantsevMichael/Prism/commit/6c62e2d079cbeb611d3cf3582cf1a56b9a90a095))
* record pending user gates in coordination state ([f2b23f9](https://github.com/RumyantsevMichael/Prism/commit/f2b23f9de57a7a4749480683c46eeb5aec880efa))
* refuse concept delta readiness when additions copy a change into duplicated functions ([c6305a4](https://github.com/RumyantsevMichael/Prism/commit/c6305a4405dc4fc94d0acd45986a339c1035d787))
* refuse concept delta readiness when modifications change copies of a duplicated function separately ([fe41461](https://github.com/RumyantsevMichael/Prism/commit/fe414616e2a23553294fed9349bbf24834100c36))
* render concept deltas, review ledgers, coordination state, and evidence in the review browser ([14ae557](https://github.com/RumyantsevMichael/Prism/commit/14ae5575b69e1b3e9c8b8de260764a80a69fb0db))
* report analysis findings that a change adds in concept delta comparisons ([5add169](https://github.com/RumyantsevMichael/Prism/commit/5add169641646b789af124aae141d7a1b9a353dc))
* report cohesion clusters and shared literal groups ([fece81a](https://github.com/RumyantsevMichael/Prism/commit/fece81a16e270eb129ef9451081e96e99034b848))
* report functions that share rare dependencies across files ([49a2b4b](https://github.com/RumyantsevMichael/Prism/commit/49a2b4b860f05ea642f153ee5a81b00b31e68d15))
* report instruction clients, entry shapes, and repeated key sets in shared literal groups ([c185f0b](https://github.com/RumyantsevMichael/Prism/commit/c185f0b7607c306df90feb9f3a3ef4acbdcbfdd1))
* report module interfaces with unused exports and delegating classes ([16cf1d8](https://github.com/RumyantsevMichael/Prism/commit/16cf1d8f792b60a17bb216252a5e35b0b1675ce2))
* resume orchestration when the user answers a gate in the browser ([84fedd4](https://github.com/RumyantsevMichael/Prism/commit/84fedd49d675bbfa172e98f9946339be7a2dc482))
* retain repository analysis results as receipts ([51585f3](https://github.com/RumyantsevMichael/Prism/commit/51585f3d691ccb34213098a56d69b103976c8dd8))
* show project source files read-only in the review browser ([4c1b7d5](https://github.com/RumyantsevMichael/Prism/commit/4c1b7d5b0b40a8e92dc5a3b4785405ed4a88a687))
* tune shared dependency groups for Go, Rust, Java, C#, and C++ ([1b2026e](https://github.com/RumyantsevMichael/Prism/commit/1b2026e18f6488523fa62496a9c523c76b511145))
* wait for a browser gate answer in a background tool call ([b79a750](https://github.com/RumyantsevMichael/Prism/commit/b79a750380b9483c1bb9ba54dc2c0d3d779645e6))


### Fixed

* explain refused record writes and wait on several gates ([e7ccb42](https://github.com/RumyantsevMichael/Prism/commit/e7ccb4234b2a2383d1cd3222ab82e99c474a1d2e))
* find the root slice in the initiative directory and gate waits on the host ([240b687](https://github.com/RumyantsevMichael/Prism/commit/240b687d8e310dff951344acd7ddf983d3d3e587))
* improve native semantic retrieval quality and preparation time ([4f74276](https://github.com/RumyantsevMichael/Prism/commit/4f7427606c24e2a9f31121cb1a0ee2ad874c4f51))
* keep agents on Prism tools and finish the initiative lifecycle ([8aaeef8](https://github.com/RumyantsevMichael/Prism/commit/8aaeef833c0908fd3960218f128048aa0e140a0d))
* keep review batches on update_review and gate cleanup of uncommitted plans ([44b19f7](https://github.com/RumyantsevMichael/Prism/commit/44b19f74d9145525f7bbee28e4ca697c5cb6625d))
* keep the dependency pairs of moved functions in the detector diff ([815a229](https://github.com/RumyantsevMichael/Prism/commit/815a229510cf7dd64045a2fafbf98e31fc6f589d))
* keep the plugin MCP definition out of project config ([44249fd](https://github.com/RumyantsevMichael/Prism/commit/44249fd6057b6595ae8d9cc9e302d39eeacb3b4c))
* lead refactoring discovery to the repository tools and name expected values in tool errors ([5a6caaa](https://github.com/RumyantsevMichael/Prism/commit/5a6caaa4f17efb694bd109e5e2bc021da674de38))
* list only the refused problems that the error message does not already state ([f93f08a](https://github.com/RumyantsevMichael/Prism/commit/f93f08ad080713525284cf5dae313e996ec39a1b))
* list refused review problems, check lane coverage and reviewPath early, and keep snapshots stable when ignored files are force-added ([13babad](https://github.com/RumyantsevMichael/Prism/commit/13babad6280b156bb876b1c31c1aaa4eeee025b0))
* match review scopes written with a trailing slash ([b727056](https://github.com/RumyantsevMichael/Prism/commit/b727056e7e7663267707038f81ae565314c7159d))
* reduce review assessments for planned private units and whole-file convergence ([7a79b7e](https://github.com/RumyantsevMichael/Prism/commit/7a79b7e607cde9bd6496abf18ccb73b1412481b2))
* remove downloaded runtime archives after extraction and prune stale native assets ([07d4e48](https://github.com/RumyantsevMichael/Prism/commit/07d4e4893f76e97eca0f4a4e45c605c31696f7fc))
* remove review harness friction and share one safety unit between the session stores ([568dc18](https://github.com/RumyantsevMichael/Prism/commit/568dc18542a041385db9b94aebb347570a2c2be8))
* report native semantic capabilities, bound provider diagnostics, and accept trailing slashes in path filters ([ed86118](https://github.com/RumyantsevMichael/Prism/commit/ed86118792240ac08c23373f42dda0d820df65b3))
* resolve Markdown links through explicit anchors and name unresolved structure ([257ac3f](https://github.com/RumyantsevMichael/Prism/commit/257ac3f19d46ebafe6edce0d042e0503a02e32b5))
* say why a review wave cannot be accepted ([dab678b](https://github.com/RumyantsevMichael/Prism/commit/dab678b650b94a07ec4498fa53135ff22d868395))
* share review browser reads across one refresh ([ee93332](https://github.com/RumyantsevMichael/Prism/commit/ee93332cd85c79df7313a637fd39b5c426e41c50))
* state the root slice folder, roadmap acceptance, and wait fallbacks ([da46edf](https://github.com/RumyantsevMichael/Prism/commit/da46edff3f126253938228371e2cf04949d02dc6))
* sync decision history records to disk before publishing them ([6ceabab](https://github.com/RumyantsevMichael/Prism/commit/6ceabab7e29250b5fd898b4090cbd58237d6c0f6))
* sync decision history records to disk before publishing them ([b51b0d9](https://github.com/RumyantsevMichael/Prism/commit/b51b0d9db3adc7aab14c97d7b2ac784659124458))
* treat new private units in planned spans and new planned files as implementation detail, and name whole-file convergence ([aa962c9](https://github.com/RumyantsevMichael/Prism/commit/aa962c9593e6dfc062f944f72b0c6dc70ca60363))


### Documentation

* accept the records ADR, propose the user gate ADR, add an upgrade guide ([5754a9a](https://github.com/RumyantsevMichael/Prism/commit/5754a9a685434d0644af098d603f8be7cfe6921e))


### Changed

* name structural source units separately from concepts ([1ba4e3c](https://github.com/RumyantsevMichael/Prism/commit/1ba4e3c38e75ddb8c02c9acf0fe1687618bcb291))
* separate runtime sources from shipped output ([#12](https://github.com/RumyantsevMichael/Prism/issues/12)) ([ab2d44c](https://github.com/RumyantsevMichael/Prism/commit/ab2d44c6c48bfc8ba539b4893d38aa5fd7c12455))
* share one safety unit between the session stores ([0052a40](https://github.com/RumyantsevMichael/Prism/commit/0052a4008c5327c30cf5c3b257a94dadaf12cd3b))

## [0.9.0](https://github.com/RumyantsevMichael/Prism/compare/v0.8.0...v0.9.0) (2026-10-05)


### Added

* add native semantic discovery and verified refactoring workflows ([67c30e4](https://github.com/RumyantsevMichael/Prism/commit/67c30e431f07f365b01ba8c92ae59c641e99c638))


### Fixed

* raise PlantUML browser render limit ([b86f126](https://github.com/RumyantsevMichael/Prism/commit/b86f126a18b48bd6d6c614a23c2a75bdb234938d))
* separate orchestration flow from invariants ([604c2ef](https://github.com/RumyantsevMichael/Prism/commit/604c2ef7e1287360f25024cd25b86ea7bc74dd36))
* verify refactoring flows and automate complete releases ([aa12522](https://github.com/RumyantsevMichael/Prism/commit/aa125220c2cd5833fbe6622688245fcdc365c636))

## [0.8.0](https://github.com/RumyantsevMichael/Prism/compare/v0.7.0...v0.8.0) (2026-09-24)


### Added

* add autonomy and agent-flow controls ([b27c062](https://github.com/RumyantsevMichael/Prism/commit/b27c0629494ab8c270b4f7e69244ad77d4411361))
* add coordination state MCP tools ([f58100c](https://github.com/RumyantsevMichael/Prism/commit/f58100c3443c1249537c01f984ef01f62fadef49))
* add repository intelligence layer ([28f421c](https://github.com/RumyantsevMichael/Prism/commit/28f421cd90b124878917f69249ea6e10b9ac44f6))
* configure CodeNib command in workflow settings ([042bbf4](https://github.com/RumyantsevMichael/Prism/commit/042bbf415852ca93bbb2890e16dcdcadb1d6047b))
* make review viewer stateful ([fdf3b62](https://github.com/RumyantsevMichael/Prism/commit/fdf3b62674cf6ea2d65e60dabac1cde9cfb9d076))


### Fixed

* bridge Codex session data to active tools ([c6d3a01](https://github.com/RumyantsevMichael/Prism/commit/c6d3a012c6ec9582c21070f528428286ec0e2993))
* centralize worker lifetime guidance ([6955490](https://github.com/RumyantsevMichael/Prism/commit/6955490a6e7a7f1095f430f7fc2795203cd30065))
* clarify direct worker communication lifecycle ([fdac0ff](https://github.com/RumyantsevMichael/Prism/commit/fdac0ffa089d783e52f2e65489e99489e13a181a))
* clarify repository intelligence providers ([c84e6b4](https://github.com/RumyantsevMichael/Prism/commit/c84e6b4d1e5fa4d0ad142b1116bac32616ef0f90))
* resolve active Codex capacity from runtime facts ([b8fb7d9](https://github.com/RumyantsevMichael/Prism/commit/b8fb7d94c44da2c02341a87c165a19e2ec2e4df3))

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
