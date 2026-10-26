# Workflow

Prism delivers an initiative as a tree of slices, and each slice that fits one agent session is designed, audited, implemented, and reviewed on its own.

## Stages

| Stage | Skill | Result |
|---|---|---|
| Prioritize | `prism:roadmap` | An ordered Now, Next, Later, and Parked roadmap |
| Shape | `prism:ideate` | Approved EARS requirement files, or a decision to stop |
| Start an initiative | `prism:orchestrate` | One root slice and a short resume note |
| Design | `prism:design` | A fit decision, Gherkin acceptance scenarios, architectural ADRs, and executable boundary artifacts when needed |
| Design audit | `prism:review` in `design-audit` mode | Requirements, boundary, contract, security, and verification findings |
| Implement | `prism:implement` | Failing tests, working code, step definitions, and verification |
| Review | `prism:review` in `implementation-review` mode | Independent findings against the completed code and intent, repeated until `CLEAN` |
| Refactor | `prism:refactor` | Relationship analysis, a desired model, and proposed or verified behavior-preserving changes |

## Slices

The roadmap owns each initiative's name, intent, priority, and Approved requirement links.
When those inputs are missing, orchestration runs `ideate` and `roadmap` first.
Design explores documents and focused code paths, then returns `FIT`, `SPLIT`, or `BLOCKED`.
On `SPLIT`, design proposes child slices and dependencies that preserve requirement coverage, and orchestration designs each child in turn.

Each fitted slice passes design audit, implementation, independent review, and your correctness confirmation.
Design can run before a slice's dependencies are implemented, but implementation needs completed dependencies and a fresh fit check.
Review repeats after corrections until `CLEAN`, your stop, or a real blocker.
After integration, delivery verifies the result, with fresh review and confirmation when behavior changes or equivalence is uncertain.

## Records

The MCP server owns the roadmap and initiative records, and agents change them only through its tools.
It validates requirement coverage and the slice dependency graph on every write, and refuses to mark a slice done without a passing completion gate.
Initiative progress on the roadmap is derived from the initiative records.
Slice files keep the design narrative, findings, and evidence needed to resume work.
A short resume note records settings, active work, pending questions, next actions, and evidence paths, so an interrupted initiative resumes where it stopped.

Requirements preserve intent, ADRs preserve decisions, and feature files preserve acceptance examples.
Tests and consumed contracts enforce behavior, diagrams explain structure, and code supplies implementation details.
Design creates new artifacts only after the fit check passes.

## Verification

A slice whose design is accepted lists its frozen acceptance tests and says whether its implementation needs independent review.
Before such a slice can be marked done, Prism runs your project's test command and records the run on the slice.
Configure the command in `.prism/workflow.md`:

```markdown
## Stack
- Test command: npm test
```

The first run of a command asks you in the review browser to allow that exact command, and a changed command asks again.
Approvals stay in Prism's local plugin data, never in your repository.
Prism refuses to run when a frozen acceptance test changed after the design was accepted.
A passing run counts only while the project's source, tests, and configuration stay as they were when it ran, so a later edit needs a new run.
When the design requires review, an independent reviewer also reviews the verified result, and a later change needs a new run and a new review.
The slice page in the review browser shows the latest run with its command, exit code, and output tail.
Verification runs need a git work tree, and `PRISM_VERIFY_TIMEOUT_MINUTES` changes the 30-minute default timeout.

## Questions and answers

Each question that waits on you is recorded, and the review browser's Attention page lists it with the artifacts to inspect.
You can answer there instead of in the conversation.
See [Review browser](review-browser.md#attention) for how the agent receives the answer.

## Autonomy and agent flow

`orchestrate` stores decision autonomy and agent flow per initiative.
Autonomy is `conservative`, `broad`, or `full`, and agent flow is `multi` or `mono`.
Mono flow keeps planning, design, implementation, and corrections in the orchestrator's context, and both flows review in fresh contexts.
Full autonomy can resolve internal decisions and turns commits on when you have not set them, while explicit commit, continuation, and push settings always apply.

## Defects

Defect repair stays outside this workflow.
Reproduce and diagnose a defect against the existing specification, and change the specification only when the required behavior must change too.

## Project files

Prism stores its configuration in `.prism/workflow.md`, and all configured paths resolve from the project root.

| Content | Default path |
|---|---|
| EARS requirements | `docs/requirements/` |
| Architecture decisions | `docs/ADRs/` |
| Initiative plans, state, slice findings, and recovery records | `docs/plans/` |
| Gherkin feature files | `docs/Features/` |
| Roadmap | `docs/roadmap.md` |
| Glossary | `docs/Glossary.md` |
| User documentation | `docs/user-guide/` |

The roadmap Markdown and each initiative's `initiative.md` are generated views of records that agents change only through Prism's MCP tools.
Slices have titles such as `Download signed reports`, while stable slugs identify slices and artifact paths.
The analysis runtime, models, indexes, and retained evidence live in the plugin data directory or your private Prism cache, never in your repository.

## Migrate an older setup

Prism no longer reads `.claude/workflow-config.md`, and `prism:workflow-init` migrates its values into `.prism/workflow.md` without changing the old file.
On resume, orchestration imports a legacy `map.puml` into the initiative record.
The `roadmap` skill proposes a roadmap record from a legacy roadmap and replaces the hand-written roadmap Markdown only after you accept it.
See [Upgrading to managed records](upgrading-to-managed-records.md) for everything that changed in Prism 0.10.0.
