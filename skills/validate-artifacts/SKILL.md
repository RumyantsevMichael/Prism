---
name: validate-artifacts
description: "Adversarial pre-code validation of a track's spec (ADR, build plan, contracts, feature files): try to implement contracts, break invariants, surface gaps. Use at the start of an implementation session, before coding."
argument-hint: '[initiative/track]'
context: fork
background: false
---

# Validate artifacts

This is the **adversarial pre-implementation check**: before a line of code, a fresh reader tries to *break* the spec on paper, where fixing a gap costs a sentence instead of a refactor.
This skill declares `context: fork`, so it always runs as an **isolated subagent**: no conversation history, only what is on disk.
That isolation is the point.
You cannot be led by the authoring session's assumptions, so read everything you need from the files.

It runs at two points, and the caller changes what happens to the findings:

- **In the implementation session, as its first act**: the primary invocation.
  Done cold, by someone who did not author the artifacts, which is exactly what makes it a fair test.
  Gaps route back to the design session and you stop, per "What to produce" below.
- **Inside the design session's validation loop**: design invokes this skill on the drafted bundle, fixes every finding, and invokes it again until a run reports no gaps.
  Each run is a fresh, isolated reader.
  The stop-and-wait-for-the-user-to-relay choreography below is for the implementation-session invocation, not this one.
  Passing the design loop never waives the implementation session's own invocation.

It is not implementation, and it is not the post-code checks.
Keep the three distinct:

- **This pass** validates the *spec*, before code.
- **Acceptance tests** validate the *implementation* against the spec, after code.
- **Live verification** validates the *running system*, after code, for what tests cannot capture.

Project settings for this workflow live in `.claude/workflow-config.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project's own CLAUDE.md conventions.
The session map and lifecycle rules live in the `workflow` overview skill.

Read the handoff first (default `/docs/plans/<initiative>/<track>/handoff.md`).
It names the authoritative inputs and their precedence.
Then read the **source request** the track answers: the track file, and any recorded product request or interview notes in the plan folder.
The request is what the artifacts must satisfy, so it is part of your input, not optional background.

---

## What to do

Work through the artifacts adversarially, not approvingly.
Your goal is to find the gap the design session is too close to see.

1. **Implement each contract on paper.** For every interface and seam in the contracts file, ask: could I actually build this with what the spec gives me?
   Does the installer receive what it needs to place its payload?
   Does the filter get the input it filters on?
   A contract you cannot satisfy is under-specified.
2. **Try to break each invariant.** Take each ADR MUST/MUST NOT and look for a path, an input, or an ordering that violates it.
   If you find one, either the invariant is wrong (feed back to the ADR) or the design admits a hole.
3. **Check the artifacts against the source request.** Compare the spec with what was actually asked: the track file, the recorded product request, and any interview answers captured in the plan folder.
   Every requirement in the request must appear in an artifact, unchanged.
   Verify concrete surface details letter-for-letter: names, keywords, formats, commands, and error strings.
   A renamed keyword or an invented capability is a real defect, not a style choice.
4. **Check the artifacts agree.** Do the contracts satisfy the ADR?
   Do the feature files describe behavior the contracts can actually express?
   Does the build plan build what the contracts declare?
   Disagreement between artifacts is a real defect, including two artifacts that name the same thing differently.
5. **Hunt under-specification.** Every `// OPEN:` in the contracts is a known gap, so confirm each is genuinely the implementer's call and not a missing decision.
   Then look for the *unmarked* gaps: a field whose meaning is ambiguous, a failure mode no artifact addresses, or a feature example that cannot be turned into a clean test.
6. **Threat-model the spec.** Read it as an attacker, not a builder.
   What is the track's **security surface**, meaning does it touch secrets, the network, privilege or isolation boundaries, untrusted input, or IPC?
   For each surface, look for the hole the spec leaves open: a secret with no defined at-rest path, a trust boundary the contracts do not enforce, an input no invariant constrains, a capability granted wider than the feature needs.
   A security gap is a spec gap: it feeds back to the ADR like any other.
   **Name the surface explicitly** (`security surface: none` is a valid finding).
   The implementation session's post-code security audit fires only when it is non-empty, so this determination is load-bearing.

## What to produce

A list of gaps, each tied to the artifact (or ADR) that owns it, with enough detail for the design session to act on, **plus a one-line statement of the track's security surface** (the threat-model lens's output, carried forward to gate the post-code audit).
**Report it and stop.** Do not resolve the gaps yourself, recommend resolutions, or proceed past them.
Clarifying the spec is the design session's responsibility: it updates the owning artifact (a wrong invariant feeds back to the ADR) **while its cache is still warm**.
That is why this runs before tear-down, not after, and you resume only once the user relays the clarification back.
Your job here is to find the gap, not to fill it.

When the artifacts hold up, say so plainly and proceed to tests-first implementation.
The point is a real attempt to break them, not a rubber stamp.
But a spec that survives a genuine attempt is cleared to build.

---

## Quality checks before finishing

- Every contract was checked for "can I implement this with what's given?"
- Every ADR invariant was checked for a way to violate it.
- The artifacts were checked against the source request, letter-for-letter on names, keywords, and formats, with no requirement dropped and no capability invented.
- Cross-artifact agreement (ADR ↔ contracts ↔ feature files ↔ build plan) was verified.
- Each `// OPEN:` is confirmed as implementer's-choice, and unmarked gaps were hunted.
- The spec was threat-modeled and the track's security surface stated in one line (`none` is valid), the post-code audit's trigger.
- Gaps are reported against the owning artifact, routed to the ADR when an invariant is wrong, not silently worked around, self-resolved, or proceeded past.
