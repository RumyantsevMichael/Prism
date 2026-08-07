# prism benchmark

This benchmark measures whether a change to the prism workflow makes agents produce better code.
It compares two or more versions of the plugin on the same tasks, with the same model, and scores the result with hidden acceptance tests.
The grading follows the same principle as SWE-bench: the agent never sees the tests that grade it.

Two properties separate it from a plain coding benchmark, because they target what a spec-driven workflow claims to deliver:

1. **Requirements must be elicited, not just executed.**
   A task's brief is a short product request, deliberately incomplete.
   The full behavior lives in a hidden reference spec, and a simulated product owner answers the agent's questions strictly from it.
   An agent that interviews well extracts a better spec.
2. **Tasks evolve across stages.**
   A staged task is a sequence of product requests implemented in fresh sessions over one persistent workspace.
   Later stages punish weak architecture and lost knowledge, which is exactly where durable artifacts should pay off.
   The divergence between arms across stages is the headline metric for the workflow's value.

## What one benchmark run does

A run executes one or more **arms** over the task suite.
An arm is one plugin version, or the no-plugin baseline.

For each arm, task, and repetition the harness:

1. Creates a fresh workspace with `BRIEF.md`, an optional seed, and a fixed `.prism/workflow.md` for Prism arms.
2. Runs the selected agent headlessly with `claude -p` or `codex exec`.
   A prism arm runs two sessions per stage, `design` then `implement`, because the workflow itself mandates a fresh session per phase.
   The baseline arm runs one plain "implement this brief" session per stage.
3. Relays questions: when a session ends without the completion marker, the harness sends the agent's message to the **product owner**, a pinned model prompted to answer only from the stage's hidden reference spec, and resumes the session with the reply (`--resume`).
   This repeats up to `--max-exchanges` times per session.
4. After each stage, injects the hidden tests for all stages so far under `_bench_tests/` and scores them with pytest in a private venv.
5. Appends one JSON record per stage to `results.jsonl` with the score, the costs, and mechanical artifact checks.

## What is measured

**Primary metric: hidden-test pass fraction, cumulatively per stage.**
Each stage ships a hidden pytest suite that tests only what the stage's reference spec states.
After stage `n` the workspace is scored against the tests of stages 1 through `n`, so a stage that breaks earlier behavior loses earlier points.
`resolved` means every hidden test passed.

**Secondary metrics, reported but never merged into one score:**

- **Stage progression**: mean pass fraction by stage index per arm.
  A workflow that pays off holds its level while the baseline decays.
- **Artifact discipline**: mechanical checks that the workflow's promised durable artifacts exist (ADR present and flipped to `Accepted`, feature files, user guide, agent-written tests).
- **Cost**: agent cost, product-owner cost, token usage, turns, exchanges, and wall time from the agent JSON output.
- Codex subscription runs report token usage but report zero API cost.
- **Phase errors**: timeouts, turn-limit hits, and crashed sessions.
  A run with a phase error still gets scored (intent-to-treat), because giving up is a behavior of the workflow under test.

## Why the community can trust a result

- **Hidden tests grade the work.** The agent sees `BRIEF.md`, never `bench/tasks/*/tests/` or `bench/tasks/*/specs/`.
  The workspace is a temporary directory outside this repository.
- **Every task has an oracle.** `selfcheck` runs each reference solution against its hidden tests, per stage, and demands 100% with an exact collection count.
  A task whose tests cannot be passed fails loudly before any measurement.
- **The product owner is scripted, pinned, and logged.** It answers only from the committed reference spec, replies "Not specified. Your decision." outside it, and never volunteers unasked requirements.
  Every exchange is saved verbatim under `logs/` for audit.
  Both arms face the same product owner.
- **Paired comparison.** All arms run the same tasks with the same pinned models, so task difficulty and model choice cancel out of the delta.
- **Uncertainty is reported, not hidden.** The report gives a paired bootstrap 95% interval over tasks (10,000 resamples, fixed seed) on final-stage scores.
  A delta whose interval crosses zero is printed as "not supported by this sample".
- **Everything is recorded.**
  `run.json` stores the models, plugin commit, host versions, and relevant machine-context fingerprints.
- **The pipeline is testable for free.** `--mock` copies the oracle instead of invoking an agent, so anyone can audit the scoring path without an API key.
  Mock records are flagged, and the report prints a warning when they are present.

## Commands

Verify the task suite:

```bash
python3 bench/harness/bench.py selfcheck
```

Test the pipeline without model cost:

```bash
python3 bench/harness/bench.py run --mock --arm current=. --arm baseline=none --reps 1
```

Prepare Codex to load the native Prism package through a temporary marketplace:

```bash
python3 bench/harness/bench.py setup-codex --plugin .
```

The command copies the shipped Codex manifest and shared skills into `bench/.cache`.
It does not rewrite skill metadata or change released plugin files.

Run one brownfield task with a Codex subscription:

```bash
python3 bench/harness/bench.py run \
  --agent codex --po-agent codex \
  --model gpt-5.4 --po-model gpt-5.4 \
  --arm baseline=none --arm prism=. \
  --tasks entire-cli-transcript-refactor --reps 1
```

Install Go before you run this task.
The harness fetches the pinned Entire CLI source, the external oracle, and Go modules during selfcheck.
Run the command from a normal shell so upstream tests can bind local test ports.

Compare two plugin versions with real agent sessions:

```bash
python3 bench/harness/bench.py run --arm v020=v0.2.0 --arm candidate=. --tasks minidb --reps 3
```

An arm ref is a plugin directory, a git ref of this repository (resolved through a temporary worktree), or `none` for the no-plugin baseline.
Useful knobs: `--model` (agent), `--po-model` (product owner), `--max-exchanges`, `--stages N` (run only the first N stages), `--keep-work` (keep workspaces for inspection).
Use `--agent codex --po-agent codex` for Codex subscription runs.

Aggregate one or more runs:

```bash
python3 bench/harness/bench.py report bench/results/<run-dir> --out bench/results/<run-dir>/report.md
```

## Reading the report

- **Per-stage pass fractions** are means over repetitions, scored cumulatively.
- **Stage progression** is the headline table for staged tasks: compare how the arms hold up as the product evolves.
- **Pairwise comparison** runs on final-stage scores.
  Claim an improvement only when the interval excludes zero.
  With few tasks the interval is wide by construction, and the report says so.
- Compare **cost** alongside quality: a version that scores equal but spends double is a regression.

## Protocol rules

- **Pin both models per run** (`--model`, `--po-model`).
  Never compare records that used different models.
- **Repetitions**: agents are stochastic, so `--reps 3` is the floor for a real comparison.
- **The config is seeded, not generated.**
  The harness writes the same `.prism/workflow.md` into every Prism workspace.
- **The completion marker.** Sessions signal completion with a `PHASE COMPLETE` line.
  Anything else routes to the product owner, up to the exchange budget, after which the session's state stands as-is.
- **Sandboxing is your job.** Claude sessions skip permission checks, while Codex sessions use `workspace-write` with network access.
  Run Claude benchmarks in a container or a dedicated user account.

## Threats to validity

Read these before quoting a number.

- **Few tasks.** Seven tasks bound what a task-level bootstrap can detect.
  Grow the suite before claiming small effects.
  Per-test granularity (251 hidden tests today) helps, but tests within a task are correlated.
- **The product owner is a model.** Its answers vary between runs and can err, which adds noise and, rarely, wrong guidance.
  Mitigations: pinned cheap model, a strict quote-the-spec prompt, full transcripts for audit, and the same product owner for every arm.
  Judge disputes by reading the logged exchanges.
- **Elicitation-dependent grading.** Hidden tests cover spec details the brief omits, so an agent that asks nothing loses points it never saw.
  That is intended measurement, not unfairness, but it makes results sensitive to the exchange budget (`--max-exchanges`), so hold it constant across arms and runs.
- **Contamination.** Briefs, specs, tests, and oracles are public in this repository, so future models may have seen them.
  Paired same-model comparison cancels most of this, but absolute scores will inflate over time.
  Treat absolute numbers as run-local, and deltas as the product.
- **Machine context leaks.** A global `~/.claude/CLAUDE.md` and user settings load into every agent session.
  The run records its fingerprint so results disclose it.
  Keep it constant within a run, and prefer a clean profile for published results.
- **Three difficulty tiers.** The small tasks (`ratelimit`, `todocli`, `mdtable`) pin a full interface and mostly measure spec fidelity.
  The design-heavy tasks (`sheetcalc`, `kvstore`) and the staged task (`minidb`) are where workflow versions can separate.
  The Entire CLI transcript task tests staged work in a large brownfield codebase.

## Adding a task

1. Create `bench/tasks/<id>/` with `task.json`, briefs, specs, `tests/`, and `oracle/`.
   A single-stage task may use the legacy layout: `brief.md` doubling as the spec, `tests/`, and top-level `test_count` and `phases` in `task.json`.
2. The brief pins the deliverable interface exactly: module name, entry points, return shapes.
   Behavioral detail belongs in the spec, reachable through product-owner questions.
   Hidden tests may test only what the spec states.
   An ambiguity discovered later is a bug in the spec, never in the agent.
3. Set each stage's `test_count` to the exact number of test cases, parametrized cases included.
4. Write the oracle, then run `selfcheck` until every stage reports `ok`.
5. Keep the deliverable standard-library only, so the agent needs no package installs.
   A **seeded brownfield task** is the exception, because it starts from a real repository with its own dependencies.

## Seeded brownfield tasks

A greenfield task builds a small deliverable, so a fresh session can read the whole workspace and rebuild the design from the code.
That makes durable artifacts redundant and hides the effect the workflow claims.
A seeded task starts from a large existing codebase instead, where reading everything is not a substitute for a written design.

Two optional `task.json` fields support this:

- `seed_repo`: `{"url": ..., "commit": ..., "path": "repo"}`.
  The harness caches the repository, checks out the pinned commit, and removes the upstream `.git`.
  The code never enters this repository, so each upstream project keeps its own license, and the pin keeps the workspace reproducible.
- `oracle_patch`: a pinned external repository file and JSON field that contain the reference patch.
  The harness applies the patch during selfcheck and mock runs without storing it in prism.
- `test_command`: the scoring command, as a list.
  It must write JUnit XML to `{junit}`, which keeps one parser for every language.
  `{venv_py}` and `{tests}` are also substituted.
  Set `test_timeout_s` when the suite needs more than 600 seconds.

Pin the toolchain the task needs, and state it in the task's own documentation.
The agent must never see the hidden tests, so keep `test_command` pointed at `{tests}` only.

Task content is frozen once a published comparison uses it.
Fixing a task's spec or tests invalidates every earlier result for that task, so bump the task id instead (for example `minidb2`).

## Layout

```
bench/
  README.md            this document
  harness/bench.py     the whole harness, standard library only
  tasks/<id>/
    task.json          stages, budgets, and expected hidden-test counts
    briefs/ or brief.md   what the agent sees, per stage
    specs/ or brief.md    the product owner's hidden reference, per stage
    tests/             hidden acceptance tests (pytest), per stage
    oracle/            reference solution that must score 100% at every stage
  results/             run outputs (work/ subdirectories are git-ignored)
```
