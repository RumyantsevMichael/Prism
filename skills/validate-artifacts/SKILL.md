---
name: validate-artifacts
description: "Validate a track specification by testing contracts and invariants for gaps. Use during design validation or as a manual isolated task."
argument-hint: '[initiative/track]'
context: fork
background: false
---

# Validate artifacts

This is the **adversarial pre-implementation check**: before a line of code, a fresh reader tries to *break* the spec on paper, where fixing a gap costs a sentence instead of a refactor.
Run this skill in an **isolated context** with no authoring conversation history.
Host metadata can enforce isolation, but the caller must still guarantee an isolated context.
Use an isolated child context or a separate fresh user-started task.
Read everything you need from the files.

The design validation loop invokes this skill on the drafted bundle.
Design fixes every finding and invokes this skill again until a run reports no gaps.
Each run must use a fresh isolated reader.
Implementation does not repeat this pass.

It is not implementation, and it is not the post-code checks.
Keep the three distinct:

- **This pass** validates the *spec*, before code.
- **Acceptance tests** validate the *implementation* against the spec, after code.
- **Live verification** validates the *running system*, after code, for what tests cannot capture.

Project settings for this workflow live in `.prism/workflow.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

Read the handoff first (default `docs/plans/<initiative>/<track>/handoff.md`).
It names the authoritative inputs and their precedence.
Then read the Approved requirement files that the track cites.
They are the source obligations that every downstream artifact must satisfy.
Read the track file and recorded plan notes for scope and orientation only.

---

## What to do

Work through the artifacts adversarially, not approvingly.
Your goal is to find the gap the design session is too close to see.

1. **Implement each contract on paper.** For every interface and seam in the contracts file, ask: could I actually build this with what the spec gives me?
   Does the installer receive what it needs to place its payload?
   Does the filter get the input it filters on?
   A contract you cannot satisfy is under-specified.
2. **Try to falsify each requirement and break each invariant.**
   Use each active requirement to find a missing state, actor, boundary, failure, or measurable condition.
   Take each ADR MUST/MUST NOT and look for a path, input, or ordering that violates it.
   If you find one, either the invariant is wrong (feed back to the ADR) or the design admits a hole.
3. **Check the artifacts against the Approved requirements.**
   Trace every active requirement to an ADR, contract, feature Rule, build-plan obligation, or justified non-executable check.
   Preserve each requirement's meaning without adding or removing an obligation.
   Verify concrete surface details letter-for-letter: names, keywords, formats, commands, and error strings.
   A renamed keyword or an invented capability is a real defect, not a style choice.
   Reject a Draft requirement file as an authoritative input.
   Check every requirement link and explicit anchor.
4. **Check the artifacts agree.**
   Do the ADRs serve the requirements without contradicting them?
   Do the contracts satisfy the ADRs and requirements?
   Do the feature files describe behavior the contracts can actually express?
   Does the build plan build what the contracts declare?
   Disagreement between artifacts is a real defect, including two artifacts that name the same thing differently.
   Read each linked `.puml` source and check it against its owning prose or interface artifact.
   Never inspect a rendered image.
   Confirm that no prose table or list duplicates diagram-owned relationships, transitions, or order.
5. **Hunt under-specification.** Every `// OPEN:` in the contracts is a known gap, so confirm each is genuinely the implementer's call and not a missing decision.
   Then look for the *unmarked* gaps: a field whose meaning is ambiguous, a failure mode no artifact addresses, or a feature example that cannot be turned into a clean test.
6. **Threat-model the spec.** Read it as an attacker, not a builder.
   What is the track's **security surface**, meaning does it touch secrets, the network, privilege or isolation boundaries, untrusted input, or IPC?
   For each surface, look for the hole the spec leaves open: a secret with no defined at-rest path, a trust boundary the contracts do not enforce, an input no invariant constrains, a capability granted wider than the feature needs.
   A security gap is a spec gap.
   Route a missing product obligation to the requirement file and an architectural invariant to the ADR.
   **Name the surface explicitly** (`security surface: none` is a valid finding).
   The implementation session's post-code security audit fires only when it is non-empty, so this determination is load-bearing.

## What to produce

A list of gaps, each tied to its owning requirement, ADR, or specification artifact, with enough detail for the design session to act on.
Also provide one line that states the track's security surface for the post-code audit gate.
**Report the findings and stop.**
Do not resolve gaps, recommend resolutions, or proceed past them.
Clarifying the specification is the design task's responsibility.
The design task updates the owning artifact while its context is still available.
Your job here is to find the gap, not to fill it.

When the artifacts hold up, say so plainly and return the clean result to design.
The point is a real attempt to break them, not a rubber stamp.
But a spec that survives a genuine attempt is cleared to build.

---

## Quality checks before finishing

- Every contract was checked for "can I implement this with what's given?"
- Every active requirement was checked for a way to falsify it.
- Every ADR invariant was checked for a way to violate it.
- Every Approved requirement was traced without a dropped obligation or invented capability.
- Every requirement link and explicit anchor was checked.
- Cross-artifact agreement between requirements, ADRs, contracts, feature files, and build plans was verified.
- Every linked PlantUML source was checked without reading a rendered image.
- No rendered diagram image or duplicate graph enumeration was found.
- Each `// OPEN:` is confirmed as implementer's-choice, and unmarked gaps were hunted.
- The spec was threat-modeled and the track's security surface stated in one line (`none` is valid), the post-code audit's trigger.
- Gaps are reported against the owning artifact.
- Wrong product obligations route to `write-requirements`, and wrong architectural invariants route to the ADR.
