# Estimate active Claude Code capacity conservatively

Status: Proposed
Created: 2026-10-17

## Requirements

[Estimate active Claude Code capacity](../../requirements/active-session-capacity.md#7) requires a marked conservative estimate for root Claude Code sessions.
[Reject unproved active-session capacity except a marked estimate](../../requirements/active-session-capacity.md#8) keeps every other unproved capacity result unsupported.

## Problem

Active session capacity worked only for Codex, so Claude Code sessions always returned `UNSUPPORTED`.
Claude Code does not report its compaction threshold to hooks.
Its trigger depends on the model window, settings, environment, a session-local `/autocompact` choice, server-side client data, and experiments, and only some of these are observable from a hook.
An exact threshold therefore cannot be attested.

## Decision

Prism MUST record Claude Code active capacity as an estimate and MUST mark every result that uses it as `ESTIMATED`.
Results built from attested host facts or complete explicit overrides MUST be marked `ATTESTED`.
The estimate MUST be no higher than the threshold implied by every observable window control.
The estimate MUST use a 1000000-token context window only for a model that names the extended window, and a 200000-token window otherwise.
The estimated compaction window MUST be the smallest of the context window, the environment window, every numeric settings window, and a 200000-token default when neither is set.
The threshold MUST be 80 percent of the compaction window after a 20000-token output reserve, or a lower observed percentage override.
Prism MUST read only the window keys from Claude Code settings files and MUST NOT run another Claude Code executable.
Prism MUST record facts only for root Claude Code sessions and MUST ignore subagent hook events.
Because a new Claude Code session has no transcript before its first model call, Prism MUST announce the correlation key on context events before any fact record exists.
Prism MUST refresh Claude Code facts on every `PreToolUse` event so a Prism tool call reads facts recorded immediately before it.
Complete explicit caller overrides MUST keep the highest precedence.

## Rationale

A low threshold errs toward `SPLIT` or `UNCERTAIN`, never toward overfilling a session.
The 200000-token default matches the window Claude Code uses when nothing raises it, so most sessions get a useful budget.
The 80 percent factor and fixed output reserve sit below the summary buffer and output reservation that Claude Code subtracts from its window.

## Alternatives

### Reproduce Claude Code's internal resolution

Declined because the resolution is internal, changes between releases, and depends on server-side values that hooks cannot observe.

### Record identity only

Declined because callers would still need to supply both capacity values, which they cannot observe either.

### Keep Claude Code explicit-input only

Declined because active capacity would stay unavailable in every Claude Code session.

## Consequences

Active capacity, fit evaluation, and consumption tools work in Claude Code without caller input.
Budgets in Claude Code are smaller than the true budget, and far smaller on an extended-window session without a configured window.
A session-local `/autocompact` window or a server experiment below 200000 tokens can still make the estimate too high, and the user guide tells callers to supply overrides then.

## Mechanism

The fact hook tries the Codex adapter first and falls back to the Claude Code adapter when no Codex transcript correlates and the Claude project directory is set.
The Claude Code adapter reads the version and main-thread model from a bounded transcript tail, keeps a hook-reported model across later events of the same session, and derives the estimate from the allowlisted environment and settings values.
The resolver supplies the documented implementation reserve for an estimated result that has no registry reserve and reports the capacity basis with the provenance.

## Decision Log
