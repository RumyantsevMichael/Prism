# Support autonomous orchestration and keep every child in a fresh agent

Status: Proposed
Created: 2026-09-13

## Requirements

No Approved requirement currently covers this plugin workflow decision.

## Problem

Prism currently delegates slice delivery while the orchestrator coordinates workers and lifecycle gates.
Some runs also need the orchestrator to continue through internal decisions without repeated user prompts.

## Decision

Prism MUST persist decision autonomy as an initiative run setting.
Decision autonomy MUST support `conservative`, `broad`, and `full`.
The orchestrator MUST run triage, ideation, design, implementation, and review in fresh child agents, and MUST NOT run any of them in its own context.
When no child agent can start, the orchestrator MUST stop and ask the user rather than work inline.
Prism MUST drop an `agentFlow` setting stored by an earlier version when it reads coordination state.
Full autonomy MAY resolve internal requirements, architecture, workflow, and completion decisions.
Full autonomy MUST NOT invent external facts, override project constraints, bypass independent review, or enable push without explicit permission.
An explicit commit or continuation setting MUST override its autonomy default.

## Rationale

An orchestrator that also designs or implements carries the authoring conversation into the work it then judges, which removes the fresh context that makes downstream checks honest, and agents that loaded another skill were observed acting as it.
The three autonomy levels provide a gradual choice between user control and uninterrupted execution.
Keeping review fresh preserves an independent check on work created by the orchestrator or delivery context.

## Alternatives

### Keep an inline `mono` agent flow for small initiatives

Withdrawn on 2026-11-05: inline design and implementation is the orchestrator acting as another skill, and Prism targets initiatives large enough to need child agents.

### Make full autonomy enable every side effect

Declined because committing and pushing have different recovery and external-impact risks.

### Add a second skill set for autonomous execution

Declined because shared skills should describe the workflow, while the orchestrator should select the execution mode.

## Consequences

Every initiative pays the coordination cost of child agents, and a host without child agents cannot orchestrate.
Full autonomy can change durable intent, so its decisions must remain in the owning requirements, ADR, roadmap, or map artifacts.
Existing state files continue with conservative autonomy when the setting is absent.

## Mechanism

The orchestrate skill lists the run settings.
The coordination-state capability validates the setting values and preserves them.
In Claude Code, a `PreToolUse` hook refuses the orchestrating execution's own load of a child skill; a child agent's load goes through.
The orchestrator passes the resolved settings to delegated contexts.

## Decision Log

2026-09-13: Proposed three-level autonomy and two-flow orchestration with independent review in every flow.
2026-11-05: Removed the `mono` agent flow; every child runs in a fresh agent, and a hook keeps the orchestrator out of child skills.
