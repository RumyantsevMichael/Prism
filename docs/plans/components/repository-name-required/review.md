# Slice review

This file is a generated view of review.json.

## implementation-review: wave-1

Verified tree: 339e0e59cbd4acf85a7da86803eb2c1425495dd5
Base: 9cf2627

- correctness: FINDINGS (rev-rn-correctness-1)

## implementation-review: wave-2

Verified tree: 177347705fa25d8ba7ac2f639b235aba5f67cddf
Base: 9cf2627

- correctness: CLEAN (rev-rn-correctness-2)

## implementation-review: wave-3

Verified tree: 8a009f25365725d89d51a2cd1257cd8b1e88487b
Base: 9cf2627

- correctness: CLEAN (rev-rn-correctness-3)

## implementation-review/correctness/guide-examples-unnamed: User-guide store examples still configure a store without a Repository line, which is now refused

- Status: VERIFIED
- Severity: low
- Evidence: docs/user-guide/workflow.md (the 'share records only between linked worktrees or clones on one machine' block, around line 233-237) shows '## Workspace\n- Store: ../prism-store' with no Repository line, and docs/user-guide/shared-records.md 'Sync a path store yourself' (around line 92-96) shows '- Store: ../prism-store\n- Store sync: on' with no Repository line. Since 96ac5d9, a user who copies either block gets repository_name_missing on every record operation; the slice changed both guides but left these examples stale.
- Condition to close: Every Markdown block in docs/user-guide/ that contains a '- Store:' line also contains a '- Repository:' line (check: grep -n -A3 '^- Store:' docs/user-guide/*.md).
- Implementer evidence: 7617b46: Repository lines added to the Store examples in workflow.md and shared-records.md.

## implementation-review/correctness/naming-upgrade-coverage-dropped: Rewritten naming test drops the upgrade guarantee that naming leaves an existing store's records, ledger, and runs unchanged

- Status: VERIFIED
- Severity: medium
- Evidence: The old test 'naming a repository keeps every record, ledger entry, and run of its store unchanged and readable' built the pre-naming store through an unnamed checkout and asserted every stored file byte-identical after naming, get_initiative revision and record unchanged, 'naming adds only the registration', and that the earlier run keeps its root-commit repository. The rewrite ('naming a refused repository moves its in-repo records ... and adds only them, its ledger entry, and its registration') only covers a refused checkout migrating after naming and asserts presence of four keys, not that nothing else was added, so its title's 'only' is unchecked. The contract change only removes the way to create that state through the tool; it does not remove the guarantee: docs/user-guide/shared-records.md still states 'Naming a repository changes no record, migration entry, or run that the store already holds', and this is the exact upgrade path of every 0.17 user with an unnamed checkout whose store already holds records. No other test covers it (the pre-ledger marker test covers only legacy markers). The state can be seeded by writing the store files directly, as the marker test does.
- Condition to close: A test in test/server/repository-names.test.mjs seeds a store as an earlier release's unnamed checkout left it (a moved initiative record, its migrations ledger entry, and a run entry whose checkout.repository is the root commit), then names the repository and asserts every seeded file is byte-identical, get_initiative reads the seeded record, the run keeps its root-commit repository, and the only store files added by the naming read are repositories/<name>.json; and the rewritten test either asserts its 'adds only' claim exactly or drops 'only' from its title.
- Implementer evidence: d27f938: seeded upgrade test restored (byte-identical store content, same revision, run keeps root-commit repository, only the registration added); rewritten test checks the exact file list its title names.

