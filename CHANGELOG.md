# Changelog

## [0.13.1](https://github.com/RumyantsevMichael/Prism/compare/v0.13.0...v0.13.1) (2026-10-21)


### Documentation

* shorter README with highlights, plus workflow and review browser guides ([#40](https://github.com/RumyantsevMichael/Prism/issues/40)) ([343cf34](https://github.com/RumyantsevMichael/Prism/commit/343cf34239d83a681167a7661d6ab12a9f0d3e2e))

## [0.13.0](https://github.com/RumyantsevMichael/Prism/compare/v0.12.0...v0.13.0) (2026-10-21)


### Added

* review browser round two and the change map rename ([#37](https://github.com/RumyantsevMichael/Prism/issues/37)) ([ea6704e](https://github.com/RumyantsevMichael/Prism/commit/ea6704e9dee9cd19af2d771ea059edc492e384e3))
* show native index build progress in the review browser ([#39](https://github.com/RumyantsevMichael/Prism/issues/39)) ([cc62b8a](https://github.com/RumyantsevMichael/Prism/commit/cc62b8ac185d71ef2081a2035db191f3eea44fd6))

## [0.12.0](https://github.com/RumyantsevMichael/Prism/compare/v0.11.0...v0.12.0) (2026-10-20)


### Added

* **review:** compact shell with project/worktree label, tabs in the top bar, and stable refresh ([52a756e](https://github.com/RumyantsevMichael/Prism/commit/52a756e6be415b24280656b3653e3684d6fee3b7))
* **review:** review browser UI improvements (shell, swimlanes, links, maximize, search) ([48c3a2d](https://github.com/RumyantsevMichael/Prism/commit/48c3a2d990dd27ad80fe46db4db5d06d25271a2d))
* **review:** swimlane board, in-app Markdown links with contents and previews, maximize, and text search ([4130398](https://github.com/RumyantsevMichael/Prism/commit/4130398d0c8e395bce74f5729a07f318f1c61e8f))


### Fixed

* list every refactor candidate in results and measure refactor discovery recall ([#32](https://github.com/RumyantsevMichael/Prism/issues/32)) ([d25057b](https://github.com/RumyantsevMichael/Prism/commit/d25057b70b8b8b00b2f0ec0bf998902405c61f04))

## [0.11.0](https://github.com/RumyantsevMichael/Prism/compare/v0.10.1...v0.11.0) (2026-10-19)


### Added

* carry unchanged review assessments forward and return an assessment skeleton ([1ab3adc](https://github.com/RumyantsevMichael/Prism/commit/1ab3adc0c4ff8048fa1cccb8a60b72b9ac14a793))
* carry unchanged review assessments forward and return an assessment skeleton ([1d20e47](https://github.com/RumyantsevMichael/Prism/commit/1d20e47f5a0f4e34ec8c06a28f2f982171fd8605)), closes [#17](https://github.com/RumyantsevMichael/Prism/issues/17)
* design a shared review app with red tests ([87b16ad](https://github.com/RumyantsevMichael/Prism/commit/87b16add24d0b7f1af768477d8da8714000bb88b))
* estimate active Claude Code session capacity conservatively ([dc1f121](https://github.com/RumyantsevMichael/Prism/commit/dc1f121b2dafdbc85aa3ecb4988487a02c307ef0))
* open prism review in the shared review app and return ([8f5b9d3](https://github.com/RumyantsevMichael/Prism/commit/8f5b9d3ad4bf8b9fc94ad7e4ff885f39e5a1a15a))
* reuse the review viewer credential only after a handoff ([8452908](https://github.com/RumyantsevMichael/Prism/commit/84529080421e978ce65197a9f1455d1453ea5ce9))
* scope correction review to files changed since the previous wave ([a9469a0](https://github.com/RumyantsevMichael/Prism/commit/a9469a0ec83a63332c49c30bdb9a01cc4472d34b))
* scope correction review to files changed since the previous wave ([c7d123c](https://github.com/RumyantsevMichael/Prism/commit/c7d123c7e17893fd4ddd532b08a6e44a3559c355))
* share one review app across sessions and projects ([1b36d90](https://github.com/RumyantsevMichael/Prism/commit/1b36d905b22509aeb344f06f90cfc285daa3ac8d))
* share one review app across sessions and projects ([2785f97](https://github.com/RumyantsevMichael/Prism/commit/2785f97b17cee9baa9cba5be7b2cc470e8d0faac))
* sign review app control requests and isolate scripts ([e2e64d9](https://github.com/RumyantsevMichael/Prism/commit/e2e64d9a73ef675acc99368641f996158b6cd4bc))
* switch projects in the review app and notify instead of opening a second tab ([8d53127](https://github.com/RumyantsevMichael/Prism/commit/8d531270779a15b054dcf31d4f75aa46760ccbf8))


### Fixed

* accept concept references under a scope written with a trailing slash ([325e508](https://github.com/RumyantsevMichael/Prism/commit/325e50854f813097895735318a59d9e753ca2315))
* bound review app requests and keep registration and links current ([f7e6173](https://github.com/RumyantsevMichael/Prism/commit/f7e61734f82ad2b386675eb6fbb3cd99c7f1328f))
* close the standalone review server when its first presentation fails ([8194185](https://github.com/RumyantsevMichael/Prism/commit/81941859ee1223ded56eb1d1b8705893687de2ae))
* cover later Codex versions with minimum-version profiles ([7b2bb6f](https://github.com/RumyantsevMichael/Prism/commit/7b2bb6f609cdbb84e018a4d5ca75caf2db54ad40))
* hold the Python public-declaration rule until a benchmark measures it ([b87a2b2](https://github.com/RumyantsevMichael/Prism/commit/b87a2b2f4192cb6819f618d878d1abf151a19fc8))
* keep review app discovery paths private ([bf932b8](https://github.com/RumyantsevMichael/Prism/commit/bf932b8277c2ec51b980cb55c71924a2b5764e38))
* keep switcher focus across refreshes and cover the remaining notice and limit rules ([113ef6c](https://github.com/RumyantsevMichael/Prism/commit/113ef6c66edde0dcce66e3ec9f3960fb7080097f))
* keep the review server body reader private ([b0f5f7c](https://github.com/RumyantsevMichael/Prism/commit/b0f5f7cd340fe5c380ef4208fad17c9455964417))
* make active session capacity work on current Codex and Claude Code ([d7da2cf](https://github.com/RumyantsevMichael/Prism/commit/d7da2cfd5a980be8a05c57d99ca822daea487560))
* offer carry-forward from the last wave that holds accepted assessments ([9006cd5](https://github.com/RumyantsevMichael/Prism/commit/9006cd5952578f48b6be4cdec630fff4ee36b0bd))
* read a project's evidence from every store its sessions report ([916a21c](https://github.com/RumyantsevMichael/Prism/commit/916a21cd022a940b4fb658cf8183fcf3b400d8db))
* refuse implementation review waves before an accepted design audit ([d146852](https://github.com/RumyantsevMichael/Prism/commit/d146852d963648ad79bb1a4289280e52bf1c913b))
* refuse implementation review waves before an accepted design audit ([aa258bc](https://github.com/RumyantsevMichael/Prism/commit/aa258bc5876f0640730a53c36f1ffd3a86f765a4))
* serve each project's evidence from the store its sessions report ([18ea1fd](https://github.com/RumyantsevMichael/Prism/commit/18ea1fd36e62e98fe486360ad0539f3f4cd1ed47))
* serve the review browser over plain HTTP on loopback ([485d1e3](https://github.com/RumyantsevMichael/Prism/commit/485d1e313f21161fc25acff712aae34fa51b369a))
* serve the review browser over plain HTTP on loopback ([c450423](https://github.com/RumyantsevMichael/Prism/commit/c450423f961c9fe6952db782ee59ed4b3beb9494))
* stop renewing a project's app lease once it falls back ([64b0c5b](https://github.com/RumyantsevMichael/Prism/commit/64b0c5ba47893046417e7c03a7e0fad746293e85))
* treat public Python declarations as public in the conservation gate ([6d28808](https://github.com/RumyantsevMichael/Prism/commit/6d28808a643a65426eb2961736fe35ed008335ee))


### Documentation

* design the review app project switcher and presentation notice ([e2603f0](https://github.com/RumyantsevMichael/Prism/commit/e2603f011b7578ebc61495ec11aae82d211da531))
* limit viewer credential reuse to a recent handoff in the shared app ADR ([8839090](https://github.com/RumyantsevMichael/Prism/commit/88390900b62d6ef02b8a0ffc51e93b7e461946f6))

## [0.10.1](https://github.com/RumyantsevMichael/Prism/compare/v0.10.0...v0.10.1) (2026-10-15)


### Fixed

* give the review demo seed lanes for every target file ([b9b0233](https://github.com/RumyantsevMichael/Prism/commit/b9b0233031599bc0882da7f39764b0594fcc2f5c))
* keep review browser summaries inside narrow windows and describe gate answer delivery for both hosts ([6ca5508](https://github.com/RumyantsevMichael/Prism/commit/6ca5508cdc87c7aba614602708b16132633397df))
* make native indexing work in cloud sessions and prune stale indexes ([dc99347](https://github.com/RumyantsevMichael/Prism/commit/dc993474ad15653410dd36cd860e6756183d9690))
* mirror the embedding model in the runtime release and prune stale indexes ([f60a3de](https://github.com/RumyantsevMichael/Prism/commit/f60a3dec405203247596acad79344141a0790a7c))
* print usage for prism review --help and report errors without a stack trace ([8a9da8c](https://github.com/RumyantsevMichael/Prism/commit/8a9da8c3556555db4fe04d9eb31ec791883013bb))
* route native asset downloads through the configured HTTPS proxy ([6c8c493](https://github.com/RumyantsevMichael/Prism/commit/6c8c49303ae20c43a3f3998fe4046505eb3c85c7))
* stabilization polish for the review demo, CLI, browser layout, and docs ([09cc63b](https://github.com/RumyantsevMichael/Prism/commit/09cc63b7f136eeda21dfdda445b58d73a48b8ddb))


### Documentation

* correct the review browser start page, certificate trust, and resume note link ([f895215](https://github.com/RumyantsevMichael/Prism/commit/f89521569a1a77ff40abcd7cfd0978e5e9a8a6b6))

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
