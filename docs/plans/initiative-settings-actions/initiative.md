# Initiative: initiative-settings-actions

This file is a generated view of initiative.json.

- **Initiative settings from the review app** (`initiative-settings-actions`): split
  - Outcome: The person changes an initiative's orchestration settings from the review app through a generic, revision-checked action registry that only the person's page can write, and running agents act on the change at its next effect point.
  - Requirements: docs/requirements/initiative-settings.md#1, docs/requirements/initiative-settings.md#2, docs/requirements/initiative-settings.md#3, docs/requirements/initiative-settings.md#4, docs/requirements/initiative-settings.md#5, docs/requirements/initiative-settings.md#6, docs/requirements/initiative-settings.md#7, docs/requirements/initiative-settings.md#8, docs/requirements/initiative-settings.md#9, docs/requirements/review-app-actions.md#1, docs/requirements/review-app-actions.md#10, docs/requirements/review-app-actions.md#11, docs/requirements/review-app-actions.md#12, docs/requirements/review-app-actions.md#13, docs/requirements/review-app-actions.md#14, docs/requirements/review-app-actions.md#2, docs/requirements/review-app-actions.md#3, docs/requirements/review-app-actions.md#4, docs/requirements/review-app-actions.md#5, docs/requirements/review-app-actions.md#6, docs/requirements/review-app-actions.md#7, docs/requirements/review-app-actions.md#8, docs/requirements/review-app-actions.md#9
  - **Generic action controls in the review page** (`action-controls`): not-started
    - Outcome: The initiative, slice, and index pages render every action generically as compact keyboard-reachable controls with confirmation and stale handling, read-only tabs say why, and every tab of the workspace's checkouts shows applied actions and their authors as they happen.
    - Requirements: docs/requirements/initiative-settings.md#1, docs/requirements/initiative-settings.md#9, docs/requirements/review-app-actions.md#1, docs/requirements/review-app-actions.md#2, docs/requirements/review-app-actions.md#5, docs/requirements/review-app-actions.md#8
    - Depends on: `write-credential`
    - Design accepted 2026-11-05: 1 frozen test files staged until the slice starts, review not required
  - **Apply actions through one registry** (`action-registry`): blocked
    - Outcome: The review app lists and applies revision-checked actions from one transport-independent registry, with the seven initiative settings, gate answers, and each component's index rebuild as its actions, and records each with its author in history.
    - Requirements: docs/requirements/initiative-settings.md#1, docs/requirements/initiative-settings.md#2, docs/requirements/initiative-settings.md#3, docs/requirements/initiative-settings.md#9, docs/requirements/review-app-actions.md#1, docs/requirements/review-app-actions.md#10, docs/requirements/review-app-actions.md#2, docs/requirements/review-app-actions.md#3, docs/requirements/review-app-actions.md#4, docs/requirements/review-app-actions.md#5, docs/requirements/review-app-actions.md#6, docs/requirements/review-app-actions.md#7, docs/requirements/review-app-actions.md#9
    - Design accepted 2026-11-05: 2 frozen test files, review required
  - **Agents act on the person's changes** (`agent-change-notices`): not-started
    - Outcome: Running agents learn of the person's changes and who made them once per session, from this machine or through store sync, in Prism's tool results and gate waits, keep the person's settings over their own, and apply the review policy at design acceptance.
    - Requirements: docs/requirements/initiative-settings.md#3, docs/requirements/initiative-settings.md#4, docs/requirements/initiative-settings.md#5, docs/requirements/initiative-settings.md#6, docs/requirements/initiative-settings.md#7, docs/requirements/initiative-settings.md#8, docs/requirements/review-app-actions.md#13, docs/requirements/review-app-actions.md#14
    - Depends on: `action-registry`
    - Design accepted 2026-11-05: 1 frozen test files staged until the slice starts, review required
  - **Merge coordination state across machines** (`state-merge`): not-started
    - Outcome: A coordination state changed on two machines within one sync window merges by its structure, so the person's changes, agents' writes, and both histories survive without a saved conflict.
    - Requirements: docs/requirements/initiative-settings.md#7, docs/requirements/review-app-actions.md#7
    - Depends on: `action-registry`
    - Design accepted 2026-11-05: 1 frozen test files staged until the slice starts, review required
  - **Write only from the page Prism opened** (`write-credential`): not-started
    - Outcome: Only a tab that Prism opened can apply actions, through a one-time grant exchanged for a per-tab write session that no agent-visible surface reveals, on the shared app and the per-project session server.
    - Requirements: docs/requirements/review-app-actions.md#11, docs/requirements/review-app-actions.md#12
    - Depends on: `action-registry`
    - Design accepted 2026-11-05: 1 frozen test files staged until the slice starts, review required
