---
name: ideate
description: "Shape a raw idea into Approved EARS requirements before planning or design."
argument-hint: '[idea]'
sdm: "0.3"
---

# Ideate on a fresh idea

Ideation turns a shapeless idea into Approved EARS requirement files that a later delivery task reads.
The job defines product intent and challenges the idea.
The job does not select a technical design.

1. If `.prism/workflow.md` exists:
   1. Read it first.
   2. Use its project paths and stack assumptions instead of the defaults below.
2. If `.prism/workflow.md` is absent, use the defaults and the project instructions for this task.
3. Read the `workflow` overview skill for the context map and lifecycle rules.

The durable output is one or more Approved requirement files.
The orchestrator can then start planning or delivery without a fresh user task.

- After the user accepts requirements, complete the required status and approval-date updates before stopping.
- Read the glossary, the product strategy document when present, and the roadmap.
- Use `docs/Glossary.md`, `docs/roadmap.md`, and `docs/requirements/` as the default paths.
- Read related requirement files.
- Skim relevant Accepted ADRs and feature files.

## 1. Frame the raw idea

1. Settle the problem with the user.
2. Identify the affected users or systems.
3. Define the observable change.
4. Ask what happens if the team does nothing.
5. Ask what users or operators do today.
6. Separate direct evidence from assumptions.

- Keep the shape open until the problem is clear.
- Don't
  - Start from a preferred solution.
  - Choose architecture, contracts, feature scenarios, or build order.

## 2. Fit the idea into the product

1. Read [delegation.md](../workflow/references/delegation.md) for bounded read-only checks.
2. Route the governed checks through its delegation procedure.
   1. Pass paths instead of file contents.
   2. Run these independent checks:
      - Check whether an Approved requirement already covers the need.
      - Check whether the idea conflicts with an Approved requirement.
      - Check whether the idea conflicts with an Accepted ADR or behavioral invariant.
      - Check which strategy pillar the idea serves.
      - Check whether the idea belongs inside an existing requirement file.

- When durable artifacts conflict, stop and present the conflict to the user.
- Don't
  - Change either artifact silently.
- When an existing requirement owns the capability, recommend an amendment.
- When an Approved requirement needs a semantic change, use the supersession rules in `write-requirements`.
- Don't
  - Change the meaning of an Approved requirement in place.

## 3. Challenge the idea

- Apply adversarial pressure before authoring a requirement file.
- Ask why the team should not build the idea.
- Find a cheaper process, policy, documentation, removal, or other alternative.
- Identify what the idea complicates or makes impossible.
- Test whether the problem is real, frequent, and important enough to require system behavior.

Killing the idea or folding it into an existing requirement is a successful result.

- Don't
  - Create requirements to justify the session.

## 4. Group the requirements

One idea can produce several requirement files.

- Group surviving obligations by coherent product capability.
- Use one file when a reader can understand the capability as one requirement set.
- Use several files when the capabilities can change, ship, or be superseded independently.
- Link related requirements across files with direct Markdown links.
- Leave outcome-slice boundaries to the design fit checkpoint.
- Don't
  - Group requirements by a technical component.
  - Group requirements by a team.
  - Group requirements by an expected delivery slice.

## 5. Author and review the files

1. Load `write-requirements` and follow its EARS reference.
2. If `.prism/workflow.md` exists and names a requirements directory, use it.
3. If `.prism/workflow.md` is absent or names no requirements directory, use `docs/requirements/` and applicable project instructions.
4. Create each requirement file as `Draft` in the requirements directory.
5. Use flat requirement numbers and explicit anchors.
6. Record unresolved architectural choices only as design questions.
7. Review wanted behavior before unwanted behavior.
8. Review the complete set for missing actors, states, failures, and measurable boundaries.

An external platform, law, contract, or operating environment can impose a valid constraint requirement.

- Don't
  - Answer unresolved architectural questions.
  - Turn unresolved architectural questions into requirement constraints.

## 6. The artifact

Requirement files in the requirements directory are the only durable output.
The `ideate` skill writes no scratch folder and does not author ADRs.
It does not change roadmap priority or initiative state.

- Update the glossary only when the idea introduces a necessary new term.

## 7. Gate

1. Present every Draft file or the reasoned recommendation to stop.
2. Ask the user to approve, revise, or reject the requirement files.
3. After explicit approval, change each accepted file to `Status: Approved`.
4. Record the approval date for each accepted file.
5. Leave each unaccepted file as `Draft`.

- Use the delivery rules in the `workflow` overview skill.
- Don't
  - Start initiative orchestration.
  - Design a slice.
  - Write code.

The next delivery context reads the Approved requirements.
