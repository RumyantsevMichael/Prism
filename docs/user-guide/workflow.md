# Workflow

Prism delivers an initiative as a tree of slices.
Each slice is designed when it is next, implemented in fresh agent sessions against frozen acceptance tests, and verified by running your tests.

## Stages

| Stage | Skill | Result |
|---|---|---|
| Shape | `prism:ideate` | Approved EARS requirement files and a roadmap entry, or a decision to stop |
| Run an initiative | `prism:orchestrate` | One root slice, then each slice in turn |
| Design | `prism:design` | A frozen contract, probed assumptions, and failing acceptance tests, or a split into child slices |
| Implement | `prism:implement` | Working code for one step of a designed slice, committed |
| Verify | the Prism server | A recorded run of your test command |
| Review | `prism:review` | Independent findings on a verified slice whose design asks for review |
| Refactor | `prism:refactor` | Relationship analysis, a desired model, and proposed or verified behavior-preserving changes |

## Slices

The roadmap owns each initiative's name, intent, priority, and Approved requirement links.
When those inputs are missing, orchestration runs `ideate` first.
Design explores documents and focused code paths, then proposes `FIT`, one contract with a plan of slices, or `SPLIT`, parts with their order and the interfaces between them, or returns `BLOCKED`.
Prism checks a proposal as soon as design makes it and keeps it pending until the design gate accepts it.
Design splits a scope only with evidence Prism can check: a contract too large for one implementer to read, an unprobed assumption that one part settles, or your own request at the design gate.
Each part of a split is designed only when the parts it depends on are done.
A long initiative therefore never freezes a contract for work that is weeks away.

A fitted slice has a contract that fixes everything a user or caller observes, a list of assumptions about the system that design either probed or made fail safe, and acceptance tests that fail until the behavior exists.
The design also lists the files it expects to change, with the functions or types involved.
You approve the design in the review browser, unless the autonomy setting accepts it for you, and the slice's [design view](review-browser.md) shows its acceptance tests as plain-language examples under the contract clauses they check.
When a slice is too large for one implementation session, its design lists ordered steps, and each step runs in a fresh session.
Implementers may not change the frozen tests, and a contract problem goes back to design.

## Records

The MCP server owns the roadmap and initiative records, and agents change them only through its tools.
It validates requirement coverage and the slice dependency graph on every write, and refuses to mark a slice done without a passing completion gate.
Initiative progress on the roadmap is derived from the initiative records.
Each slice folder keeps the slice design in `slice.md`, and a recovery note when a run pauses.
A short resume note records settings, active work, pending questions, next actions, and evidence paths, so an interrupted initiative resumes where it stopped.

Requirements preserve intent, ADRs preserve decisions, and feature files preserve acceptance examples.
Tests and consumed contracts enforce behavior, and code supplies implementation details.

## Verification

A slice whose design is accepted lists its frozen acceptance tests and says whether its implementation needs independent review.
Before such a slice can be marked done, Prism runs your project's test command and records the run on the slice.
The implementer asks for that run itself and fixes failures in its own session; when it finds the contract wrong, it reports the clauses instead, and the slice waits for a revised design.
Configure the command in `.prism/workflow.md`:

```markdown
## Stack
- Test command: npm test
```

The first run of a command asks you in the review browser to allow that exact command, and a changed command asks again.
Approvals stay in Prism's local plugin data, never in your repository.
The command runs with your shell in the project root and the environment of the Prism server, except `NODE_USE_ENV_PROXY`, which Prism sets only for its own downloads.
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
Conservative autonomy waits for you at every design gate, broad autonomy accepts a design unless it changes requirements, adds an ADR, or reports an open question, and full autonomy accepts every design.
Multi flow runs design, each implementation step, and review in fresh child agents, while mono flow runs design and implementation in the orchestrator's context.
Full autonomy turns commits on when you have not set them, while explicit commit, continuation, and push settings always apply.

## Defects

Defect repair stays outside this workflow.
Reproduce and diagnose a defect against the existing specification, and change the specification only when the required behavior must change too.

## Project files

Prism stores its configuration in `.prism/workflow.md`, and all configured paths resolve from the project root.

| Content | Default path |
|---|---|
| EARS requirements | `docs/requirements/` |
| Architecture decisions | `docs/ADRs/` |
| Slice designs and recovery notes | `docs/plans/` |
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
`prism:workflow-init` proposes a roadmap record from a legacy roadmap and replaces the hand-written roadmap Markdown only after you accept it.
See [Upgrading to managed records](upgrading-to-managed-records.md) for everything that changed in Prism 0.10.0.
