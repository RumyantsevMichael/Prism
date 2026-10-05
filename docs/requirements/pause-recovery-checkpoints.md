# Pause recovery checkpoints

Status: Approved
Created: 2026-09-26
Approved: 2026-09-26

## Problem

Prism tells agents to update recovery records before they pause or replace active work, but the record can remain stale when the agent does not complete that manual step.

## Goals

- Make a pause checkpoint a verifiable workflow action.
- Record enough current state for another agent to resume unfinished work safely.
- Report missing checkpoint information or evidence before the workflow reports that it is ready to pause.

## Non-goals

- Store complete conversation transcripts in recovery records.
- Prevent a user from pausing work outside the Prism workflow.

## Design questions

- Should one operation update both the initiative state and the slice recovery record, or should one artifact own the resume facts?
- What evidence can Prism validate automatically to determine whether a recovery record is current?

<a id="1"></a>
## 1. Produce a current pause checkpoint

Pattern: Event-driven

Disposition: Active

Requirement: When the orchestrator requests a pause checkpoint for active slice work, Prism shall validate and persist the active phase, workspace, current evidence, unfinished work, and next action before reporting checkpoint success.

Rationale: A typed checkpoint makes the resume handoff inspectable and reduces dependence on an agent remembering a prose update.

Related: n/a

<a id="2"></a>
## 2. Reject incomplete pause checkpoints

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a pause checkpoint omits a required field or references unavailable evidence, then Prism shall report an incomplete checkpoint and identify the missing field or artifact.

Rationale: An incomplete checkpoint cannot provide a reliable resume path.

Related: [Produce a current pause checkpoint](#1).

<a id="3"></a>
## 3. Preserve recovery data when checkpoint persistence fails

Pattern: Unwanted behavior

Disposition: Active

Requirement: If Prism cannot persist a pause checkpoint, then Prism shall preserve the previous recovery record and report that checkpoint completion failed.

Rationale: A failed checkpoint must not replace a usable recovery record or appear ready for pause.

Related: [Produce a current pause checkpoint](#1).
