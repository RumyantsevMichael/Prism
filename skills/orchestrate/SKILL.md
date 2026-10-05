---
name: orchestrate
description: "Run or resume an initiative through recursive design, implementation, independent review, and user gates."
disable-model-invocation: true
argument-hint: '[initiative]'
sdm: "0.3"
---

# Orchestrate an initiative

The [workflow terms](../workflow/SKILL.md#common-terms) define the shared lifecycle.
The diagrams own phase order, branches, and returns.
The prose defines inputs, constraints, and tool arguments.

## Core flow

The following PlantUML block defines the required orchestration process.
The [pause flow](references/pause-flow.puml) applies when unfinished work must pause.

```plantuml
@startuml
title Orchestrate an initiative

start
:Read workflow configuration, run settings, worker lifetime, and initiative inputs;
:Call get_coordination_state tool;
if (Settings missing?) then (yes)
  :Call update_coordination_state tool before active work;
endif
if (Initiative inputs missing?) then (yes)
  :Run ideate and roadmap skills under the autonomy gate;
endif
if (Map missing?) then (yes)
  :Run write-map skill;
  :Run roadmap skill;
endif

while (An unfinished leaf can progress?) is (yes)
  :Select a candidate leaf;
  :Read its coordination activity, outcome,\nreview findings, and current artifacts;
  if (Resuming or replacing a worker?) then (yes)
    :Inspect recorded workers and workspaces against actual artifacts;
    if (Worker records conflict?) then (yes)
      :Ask the responsible worker to reconcile records\nagainst actual artifacts;
      :Re-read worker records and actual artifacts;
    endif
  endif
  if (Current FIT outcome exists?) then (no)
    :Run write-map skill;
    :Run roadmap skill;
    :Collect ancestor evidence and run design\nin the selected agent flow;
    if (Design returned SPLIT?) then (yes)
      :Check unique child slugs, unchanged parent title,\nexact coverage, and map consistency;
      if (Coverage or map conflict?) then (yes)
        :Return the specific defect to design;
      else (no)
        :Derive child dependencies from parent design\nand the current map;
        :Accept the split and dependencies under the autonomy setting;
        if (Late split has preserved work or findings?) then (yes)
          :Preserve completed work and original review lane paths\nin recovery evidence;
        endif
        :Run write-map skill;
      endif
    else (no)
      if (Evidence changes dependencies?) then (yes)
        :Apply the autonomy gate before changing the map;
        :Run write-map skill;
      endif
      if (Design returned BLOCKED?) then (yes)
        :Record the blocker and seek independent work;
      endif
    endif
  endif
  if (Current FIT outcome exists?) then (yes)
    :Read review, delivery, and completion rules;
    :Resume at the first unmet gate\nand repeat gates with outdated evidence;
    :Run independent design audit and corrections;
    if (All design audit lanes CLEAN?) then (yes)
      :Confirm red checkpoint and visual review;
      :Apply the implementation gate;
      :Wait for effective dependencies and recheck fit;
      if (Fit or design changed?) then (yes)
        :Invalidate FIT and return to design;
      else (no)
        :Preserve the immutable review base;
        :Run or resume implement skill in the selected agent flow;
        if (Implementation needs redesign?) then (yes)
          :Invalidate FIT and return to design;
        elseif (Implementation BLOCKED?) then (yes)
          :Record the blocker and seek independent work;
        else (ready)
          :Run independent implementation review and corrections;
          if (All review lanes CLEAN?) then (yes)
            :Preserve the reviewed result;
            :Integrate and verify the integrated tree;
            :Review changed behavior and preserved ancestor lanes;
            :Complete visual review and correctness gate;
            if (All completion gates pass?) then (yes)
              :Accept eligible ADRs and apply commit and push settings;
              :Run write-map skill for the done transition;
            else (no)
              :Keep the leaf active and resolve the missing gate;
            endif
          else (no)
            :Route unresolved lanes to correction, design, or a blocker;
          endif
        endif
      endif
    else (no)
      :Record the blocker or unresolved audit lane;
    endif
  endif
  :Call get_coordination_state tool;
  :Call update_coordination_state tool;
  if (Leaf done and continuation is stepwise?) then (yes)
    :Follow pause-flow.puml;
    :Report the completed leaf;
    stop
  endif
endwhile (no)

if (All leaves and preserved finding lanes are done?) then (yes)
  :Graduate durable information;
  :Run roadmap skill;
else (no)
  :Report blockers or wait under continuation settings;
  if (Unfinished work must pause?) then (yes)
    :Follow pause-flow.puml;
  endif
endif
stop

@enduml
```

## Inputs and coordination contracts

Required inputs are:
- `.prism/workflow.md`
- the roadmap initiative
- intent
- Approved requirements
- `map.puml`
- linked evidence when they exist.
The [run settings](references/run-settings.md) define decision gates and agent flow.
The [worker lifetime](references/worker-lifetime.md) rules define valid worker waits, resumes, and replacements.
The `get_coordination_state` input includes the initiative path, even when `state.json` does not exist.
The `update_coordination_state` input includes the current revision.
Settings resolution supplies `changes.settings`.
Initiative state updates supply current workers, blockers, next actions, and evidence paths.
Missing records establish neither approval nor completion.
The agent flow is immutable after active work starts.
Dependent work requires its applicable gate under the resolved autonomy setting.

## Design and worker invariants

The design worker receives ancestor diagram and ADR paths, including inherited paths.
Design can start before prerequisite implementation when available evidence supports it.
An existing `slice.md` supplies the design outcome record.
The configured `agentFlow` controls design and implementation routing.
In `multi` flow, the `Develop <slice>` worker receives requirements, map, workspace, settings, and ancestor paths.
The `Develop <slice>` worker remains available after `FIT` for implementation and corrections.
`write-map` receives the root title and complete Approved requirement assignment when no map exists.
`write-map` receives leaf status (`in-progress` or `done`), accepted child slugs, and dependency edges when they change.
The `roadmap` update receives status (`planned`, `in-progress`, or `shipped`) and the map path.

A valid `SPLIT` has unique child slugs, an unchanged parent title, and exact collective requirement coverage.
Child dependencies follow the parent design and map, and require acceptance under the autonomy setting.
An accepted split parent never executes again.
Its completion waits for all descendants and preserved findings.
Late splits preserve completed work and original review lane paths in recovery evidence.
A split result is persisted only when a later worker needs a fact that no existing artifact owns.

## Delivery invariants

Delivery requires a current `FIT` result.
The [review and correction rules](references/review-rules.md) apply to design audits and implementation reviews.
The [delivery rules](references/delivery-rules.md) define implementation constraints.
The [integration and completion rules](references/completion-rules.md) define integration and completion constraints.

## State and recovery invariants

The initiative's `state.json` records current coordination facts beside `map.puml`.
Typed `activeOperations` use `start`, `update`, `finish`, and `release`; only `finish` claims completion after the server checks current review evidence.
Activities are `design`, `implementation`, `review`, and `integration`, with descriptive labels stored separately.
The map alone owns slice topology, requirement assignments, dependencies, and status.
The orchestrator is the only workflow writer for initiative state.
Mono delivery records `orchestrator` as the active worker and the current workspace.
State evidence paths resolve from the note's directory unless absolute.
Empty lists mean no current item.
An old recovery note for an inactive parent slice is historical evidence, not an active pause failure.

The `checkpoint_pause` input includes the current revision, active slice, recovery content and path, and state changes.
The fallback `update_coordination_state` input includes the current revision, recovery path, and state changes.
The fallback applies only when `checkpoint_pause` is unavailable and the other coordination-state tools work.
A completed pause requires recovery and state updates.
Replacement workers need retained recovery and ancestor evidence after compaction or handoff.
Older coordination files remain until their required information has a durable home.
Conversation-only facts belong in the owning slice folder only when a later worker needs them.
The [delegation procedure](../workflow/references/delegation.md) governs child-worker delegation.

- Don't
  - Create user-owned tasks as child-agent substitutes.
