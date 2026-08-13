---
name: ideate
description: "Shape a raw idea into Approved EARS requirements before planning or design."
disable-model-invocation: true
argument-hint: '[idea]'
---

# Ideate on a fresh idea

This is ideation, one rung before `plan` and `design`.
It turns a shapeless idea into Approved EARS requirement files that a later task reads cold.
Run inline with the user and delegate read-heavy work to child agents when available.

Project settings for this workflow live in `.prism/workflow.md` at the project root.
Read that file first if it exists.
It overrides the default paths and stack assumptions below.
If it is absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

The job is challenging and defining product intent, not technical design.
Decide what problem exists, who has it, and what the system must do differently.
Do not choose architecture, contracts, feature scenarios, or build order.
The durable output is one or more Approved requirement files.

`ideate` is optional.
Use it only when the idea is genuinely shapeless and needs interactive exploration.
Use `write-requirements` directly when the capability and obligations are already clear.

Use one workflow skill per context, as defined in the `workflow` overview skill.
Do not run `plan` or `design` in this context after the user accepts the requirements.
The next task must read the Approved requirements without this conversation history.

Read the glossary, product strategy document when present, and roadmap.
Use `docs/Glossary.md`, `docs/roadmap.md`, and `docs/requirements/` as the default paths.
Read related requirement files and skim relevant Accepted ADRs and feature files.

## 1. Frame the raw idea

Settle the problem, affected users or systems, and the observable change with the user.
Keep the shape open until the problem is clear.
Do not start from a preferred solution.

Ask what happens if the team does nothing.
Ask what users or operators do today.
Separate direct evidence from assumptions.

## 2. Fit the idea into the product

Delegate these checks to child agents when available.
Pass paths instead of file contents.

- Check whether an Approved requirement already covers the need.
- Check whether the idea conflicts with an Approved requirement.
- Check whether the idea conflicts with an Accepted ADR or behavioral invariant.
- Check which strategy pillar the idea serves.
- Check whether the idea belongs inside an existing requirement file.

Stop on a conflict between durable artifacts.
Present the conflict to the user instead of changing either artifact silently.

Recommend an amendment when an existing requirement already owns the capability.
Do not change an Approved requirement's meaning in place.
Use the supersession rules in `write-requirements` for a semantic change.

## 3. Challenge the idea

Apply adversarial pressure before you author a requirement file.
Ask why the team should not build it.
Find the cheaper process, policy, documentation, or removal alternative.
Identify what the idea complicates or makes impossible.
Test whether the problem is real, frequent, and important enough to require system behavior.

Killing the idea or folding it into an existing requirement is a successful result.
Do not create requirements to justify the session.

## 4. Group the requirements

Group surviving obligations by coherent product capability.
One idea can produce several requirement files.
Do not group by technical component, team ownership, or expected implementation track.

Use one file when a reader can understand the capability as one product obligation set.
Use several files when the capabilities can change, ship, or be superseded independently.
Link related requirements across files with direct Markdown links.
Leave technical subsystem and implementation-task boundaries to `plan` and `design`.

## 5. Author and review the files

Load `write-requirements` and follow its EARS reference.
Create each file as `Draft` in the requirements directory, with `docs/requirements/` as the default.
Use flat requirement numbers and explicit anchors.

Record unresolved architectural choices only as design questions.
Do not answer them or turn them into requirement constraints.
An external platform, law, contract, or operating environment can impose a valid constraint requirement.

Review wanted behavior first and unwanted behavior second.
Review the complete set for missing actors, states, failures, and measurable boundaries.

## The artifact

Requirement files in the requirements directory are the only durable output.
`ideate` writes no scratch folder and does not author ADRs.
It does not change roadmap priority or initiative state.
Update the glossary only when the idea introduces a necessary new term.

## Gate

Present every Draft file or the reasoned recommendation to stop.
Do not open a plan, design a track, or write code.
Ask the user to approve, revise, or reject the requirement files.
Use the delivery rules in the `workflow` overview skill.

After explicit approval, change each accepted file to `Status: Approved` and record the approval date.
Leave any unaccepted file as `Draft`.

Recommend the next fresh task after approval:

- Recommend `design` for one self-contained capability.
- Recommend `plan` for an initiative that needs several dependency-ordered tracks.
- Recommend `roadmap` first when priority among initiatives remains unsettled.

The next task starts fresh and reads the Approved requirements cold.
