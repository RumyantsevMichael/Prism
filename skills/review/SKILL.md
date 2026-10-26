---
name: review
description: "Independently review the verified implementation of a slice whose design asks for review, and record findings until the result is clean."
sdm: "0.3"
---

# Review a slice

A review runs in a fresh session without the implementers' conversation.
It reviews the result that the slice's last passing verification run tested.

## 1. Prepare

1. Read `.prism/workflow.md` and the project instructions.
2. Read the inputs that orchestration supplies: the initiative and slice identifiers, the wave and lane, your reviewer identifier, and the base commit.
3. Read the slice's `slice.md`, its assigned Approved requirements, and the ADRs it links.
4. Read the current findings through `get_review`.
5. Read the complete diff from the base commit to the working tree.

## 2. Review

- Check that the changed code satisfies each requirement and contract clause, beyond what the acceptance tests assert.
- Check error, lifecycle, cancellation, concurrency, cleanup, and compatibility behavior that the change touches.
- Check trust boundaries: untrusted input, secrets, authorization, privilege, storage, network, and inter-process access.
- Check for behavior outside the Approved intent, unrelated edits, and stale user or operator guidance.
- When a finding needs executable proof, add one minimal failing test through a public surface in the project's test location and name it in the finding.

- Don't
  - Change production code, frozen tests, or existing tests.
  - Open a finding whose condition to close contradicts another open finding or needs a change that follows completion, such as accepting a Proposed ADR.

## 3. Record

1. For each defect, call `update_review` with an `open_finding` operation that names the lane, a local identifier, the title, severity, affected path, evidence, and a condition to close that you can check.
2. For each `FIXED` finding, check its implementer evidence and the code:
   - When the condition to close holds, set it `VERIFIED`.
   - Otherwise set it `REOPENED` with the remaining failure.
3. Submit the lane with `submit_lane`: `CLEAN` when no finding remains open, otherwise `FINDINGS`.

Each `update_review` call names your reviewer identifier with the `reviewer` role and the revision that `get_review` returned.

## 4. Return the result

- Return `CLEAN`, or `FINDINGS` with the unresolved finding identifiers.
