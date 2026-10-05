# Direct skill evaluation catalogs

## Refactoring behavior trials

`refactor-cases.json` defines independent trials for preserved exceptions, misleading similarity, analysis-only authority, and useful abstractions that increase concept count.
Each case separates its visible prompt and workspace files from private review criteria and optional executable behavior probes.
These trials use independent agent execution and review instead of phrase matching.

1. Create an isolated temporary workspace from a case's `workspace_files`.
2. Save its original bytes outside that workspace.
3. Give a fresh agent only the case prompt, workspace path, and `skills/refactor/SKILL.md`.
4. Keep the case catalog, review criteria, and probe source outside the agent's context.
5. After the agent finishes, run its hidden probe beside the resulting files when the case supplies one.
6. Compare the result and evidence against the private review criteria.
7. For analysis-only requests, compare every workspace path and byte against the original snapshot before adding a probe.
8. Record observed behavior and uncertainty without treating a smaller artifact or passing probe as proof of conceptual improvement.

The hidden probes test public behavior across error classes, boundary values, defaults, and adapter distinctions.
Independent review checks knowledge ownership, instruction meaning, and conceptual tradeoffs that those probes cannot establish.
These trials do not produce paired benchmark claims or prove behavior for all future model invocations.

## Automated A/B catalogs

`implement_scenarios.py` defines the hidden catalog for the direct `implement` evaluation.
It compares the original `skills/implement/SKILL.md` behavior with `docs/implement-sdm-experiment.md` behavior.
The implement catalog keeps deterministic fixtures and assertions outside each agent workspace.

`scenarios.py` defines isolated prompts for direct `write-adr` evaluation.
`run.py` runs either catalog against two staged plugin arms.

Run the implement evaluation with a mock model before a paid run:

```bash
python3 bench/skill_eval/run.py run --skill implement --mock --out bench/skill_eval/results/implement-mock
```

Pass `--candidate <path>` to compare a different candidate skill without changing the catalog.

Run the write-ADR mock evaluation with the same pipeline:

```bash
python3 bench/skill_eval/run.py run --skill write-adr --mock --out bench/skill_eval/results/write-adr-mock
```

Run the mechanical catalog and staging checks:

```bash
python3 -m py_compile bench/skill_eval/*.py
python3 bench/skill_eval/run.py selfcheck
```

Generate reports from mock or synthetic result files:

```bash
python3 bench/skill_eval/report.py bench/skill_eval/results/implement-mock --resamples 40
python3 bench/skill_eval/report.py bench/skill_eval/results/write-adr-mock --resamples 40
```

Each `Scenario` has a stable `id`, one `prompt`, visible `workspace_files`, and hidden `assertions`.
The runner copies only `workspace_files` into the agent workspace.
It keeps `assertions` and this catalog outside that workspace.

Each `Assertion` has a `kind`, a workspace-relative `target`, and an optional `value`.
Targets can be literal paths or glob patterns.
Regular expression values apply to matched file content or complete agent output.
`changed_paths_exact` compares all added, changed, and removed workspace paths with an exact path tuple.
Its target is empty, and its value is the expected path tuple.
`file_appended` requires a seeded file to retain all seeded bytes as an unchanged prefix and add new bytes.
`file_contains` passes when at least one matched file contains the expression.
`file_not_contains` passes when at least one file matches and no matched file contains the expression.
`file_unchanged` compares a completed file with its seeded bytes.
`glob_count` compares the match count with an integer value.
`output_contains` matches a regular expression against the complete agent output.
`path_exists` and `path_absent` do not use a value.

Result records use `schema_version: 2` and identify the tested `skill`.
The `score.invocation_error` field contains the invocation error or `null`.
Each record contains `plugin_skill_sha256` for its staged arm skill file.
The report requires one stable `plugin_skill_sha256` value per arm across all input records.

All checks are deterministic file, glob, byte, or regular expression checks.
No assertion needs model-based grading.

The write-ADR configuration stages only the manifests plus the `write-adr` and `workflow` skills.
The two arms differ only in the staged `write-adr` file.
The runner invokes `write-adr` explicitly on each host.
Claude uses the `/prism:write-adr` slash command and defaults to the `sonnet` model alias.
Codex uses the documented `Use the prism:write-adr skill` prompt wording.
Codex installs each arm from its own local marketplace and isolated `CODEX_HOME`.
The implement configuration stages only the manifests, the `implement` and `workflow` skills, and the required review skill files.
The two implement arms differ only in the staged `implement` file.
The runner invokes `implement` explicitly on each host.
Hidden catalogs stay outside all staged plugins and agent workspaces.
The report rejects pairs with different agents, models, seeds, mock flags, or seed snapshots.
Quality metrics keep errored runs, while resource metrics exclude pairs with an error in either arm.
An invocation error always fails its scenario and adds one critical failure.
Token totals include ordinary input, cached input, and output tokens once.
Codex subscription runs do not expose a per-run cost, so reports show `N/A` for their cost differences.
