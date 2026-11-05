# Initiative settings from the review app

## Outcome

The person changes an initiative's orchestration settings from the review app through a generic, revision-checked action registry that only the person's page can write, and running agents act on the change at its next effect point.

## Contract

The review page base is the URL prefix of one project's review: `/session/<viewer>` on a per-project session server, and `/session/<viewer>/p/<project>` in the shared review app.
Every route below exists under both, with the same behavior, unless a clause names one.

### Targets and the action listing

1. A target reference is one of `initiative:<initiative>`, `slice:<initiative>/<slice>`, `gate:<initiative>/<gate id>`, or `index`, where identifiers follow the existing slug and gate id rules.
   An initiative target exists while the initiative has an initiative record or a roadmap entry, a slice target while its initiative record holds the slice, a gate target while the initiative's coordination state lists the gate as pending, and `index` always.
2. `GET <base>/api/actions?target=<reference>` answers 200 with `{ target, writable, actions }`, where `target` echoes the reference, `writable` is clause 25's answer, and `actions` lists every action that applies to the target, available or not.
   A malformed reference, or one whose target does not exist, answers 404 with `{ code: "unknown_target", message }`.
3. Each entry of `actions` is an action view `{ id, label, group, target, value, fields, effect, available, reason, confirm, revision }`:
   - `id` is a stable dotted identifier, such as `initiative.push`.
   - `label` is a short name, and `group` names what the action changes, such as `Initiative settings`.
   - `target` is the reference that an apply request names, which for a setting listed on a slice page is the initiative's reference.
   - `value` is the action's current value, or `null` for an action without one.
   - `fields` lists the inputs as `{ name, kind, label, options, required, requiredWhen, maxLength, multiline }`, where `kind` is `choice`, `toggle`, or `text`, `options` is a list of `{ value, label }` for `choice` and exactly `[{ value: "off" }, { value: "on" }]` with labels for `toggle` and `null` for `text`, `required` is a boolean, `requiredWhen` is `null` or `{ field, values }` making the field required while that other field holds one of `values` (`null` standing for empty), and `maxLength` and `multiline` apply to `text` and are `null` otherwise.
   - `effect` is one sentence on when the change takes effect.
   - `available` is a boolean, and `reason` is the sentence why not, or `null` while available.
   - `confirm` is `null` or `{ field, values, message }`: an input whose `field` holds one of `values` needs the person's confirmation, and `message` says what it lets agents do.
   - `revision` is the revision of the record that the action changes, or `null` while that record does not exist or when the action changes no record.
4. An initiative target lists the seven setting actions of clause 6, in the order `autonomy`, `agentFlow`, `commit`, `push`, `continuation`, `review`, `models`, each with `group` `Initiative settings`.
   A slice target lists the same seven actions of its initiative, with `target` naming the initiative, so a slice page changes the initiative's settings.
   A gate target lists `gate.answer`, and `index` lists `index.rebuild`.
5. An action is one definition in the registry: its id, the target kinds it applies to, its fields, its effect, its availability rule, its confirmation rule, the record it changes, and how it changes it.
   The registry lives in a module that neither imports nor needs HTTP: `listActions({ projectRoot, target })` returns `{ target, actions }` and `applyAction({ projectRoot, target, action, input, revision, confirmed, via })` returns clause 12's result, both from `dist/server/workflow/actions.mjs`, and every refusal throws an error with `code` and the fields that clause 13 gives it.
   The HTTP routes only translate requests, refusals, and the write credential, so another transport such as a desktop shell serves the same registry, and a later action, such as a request to an agent or a comment on a document, joins by adding a definition without changing the listing, the apply path, the routes, or page code.

### The initiative settings

6. Each setting action has `id` `initiative.<setting>`, changes the initiative's coordination state, takes its value from the stored setting or, while unset, from the default, and has these fields, effects, and confirmations:

| Setting | Fields | Default value | Effect | Confirm |
| --- | --- | --- | --- | --- |
| `autonomy` | `value` choice `conservative`, `broad`, `full` | `conservative` | `Decides which later gates wait for you; a gate already open keeps waiting for you.` | `value` `full`: `Agents will accept every design and resolve internal decisions without you.` |
| `agentFlow` | `value` choice `multi`, `mono` | `multi` | `Applies when work on the initiative starts.` | none |
| `commit` | `value` toggle | `on` while `autonomy` is `full`, otherwise `off` | `Applies to child sessions started after the change.` | `value` `on`: `Agents will commit their changes to Git history.` |
| `push` | `value` toggle | `off` | `Applies to child sessions started after the change.` | `value` `on`: `Agents will push finished slices beyond this machine.` |
| `continuation` | `value` choice `auto`, `stepwise` | `auto` | `Applies when the slice in progress finishes.` | none |
| `review` | `value` choice `marked`, `recommended`, `all` | `marked` | `Sets the review mark of slices whose design is not yet accepted.` | none |
| `models` | `mode` choice `host defaults`, `custom`; `delivery`, `review`, `securityReview` text required when `mode` is `custom`; `examples` text, optional | `host defaults` | `Applies to child sessions started after the change.` | none |

7. The `models` value is the string `host defaults` or the object `{ delivery, review, securityReview, examples }`, without `examples` when it is empty; its text fields take at most 200 characters, and applying `mode` `host defaults` stores `host defaults` and ignores the text fields.
8. `initiative.agentFlow` is unavailable with the reason `Agent flow is fixed once work on the initiative starts.` while any slice of the initiative record has a status other than `not-started`, any slice holds a live claim, or the coordination state lists active work.
9. Every other setting action is available while its initiative target exists.

### Applying an action

10. `POST <base>/api/actions/apply` takes a JSON body `{ action, target, input, revision, confirmed }` of at most 64 KiB, where `input` maps field names to values and `confirmed` is optional.
    A request whose `Content-Type` is not `application/json`, or whose `Origin` names another host than the request's `Host`, answers 403 with `{ code: "origin_refused", message }`.
11. The apply route checks a request in this order and stops at the first refusal, which changes no record and runs nothing: the origin of clause 10, the write credential of clause 22, the target of clause 2, the action, the revision, availability, the input, and confirmation.
12. An applied action answers 200 with `{ applied, actions }`, where `applied` is the history entry of clause 16, and `actions` is the target's action listing after the change.
    An input equal to the current value changes and records nothing, needs no confirmation, and answers 200 with `applied: null`.
13. Refusals answer with a JSON body holding `code` and `message`:
    - An action that the target does not list answers 404 with `unknown_action`.
    - A `revision` that differs from the action's current `revision` answers 409 with `stale_revision` and `current`, the action's current view, so the page shows the value as it is now.
    - An unavailable action answers 409 with `action_unavailable`, its `reason`, and `current`.
    - An input that the fields do not accept answers 400 with `invalid_input`, the `field` it names, and `accepted`: the option values of a choice or toggle, or a sentence naming the text limit, the required field, or the unknown field name.
    - An input that clause 3's `confirm` matches, without `confirmed: true`, answers 409 with `confirmation_required` and the confirmation `message`, and the same request with `confirmed: true` applies it.
14. Applying a setting writes the new value into the initiative's coordination state, creating that state when it does not exist yet, and marks the setting as the person's under `personSettings.<setting>` with the time, in the same locked write as its history entry.
15. Every review app change to a Prism record goes through the apply route, and `<base>/api/gates/answer` and `<base>/api/indexing/rebuild` answer 404.
    An action changes only Prism records and runs no command, changes no project file, and runs no Git operation, except that `index.rebuild` starts Prism's own repository indexer as the rebuild route did.

### History

16. A history entry is `{ seq, action, target, before, after, at, via }`, where `seq` is an integer that grows by one per entry within its history, `before` and `after` are the values the person saw and set, `at` is an ISO time, and `via` is `review-app`.
17. An action on an initiative, slice, or gate target appends its entry to the initiative's history, which the coordination state keeps as `history` with its newest 200 entries, and `index.rebuild` appends its entry to the project history record, whose record path is `.prism/history.json` beside the roadmap record, with its newest 200 entries.
18. `update_coordination_state` and `checkpoint_pause` refuse `history` and `personSettings` in their changes with `invalid_changes`, so only the registry writes them.

### Gate answers and the index

19. `gate.answer` has a `choice` field and a `note` text field of at most 4000 characters, multiline, by gate kind:
    - `visual-review` and `correctness`: `choice` options `approve` and `request-changes`, required, and `note` required when `choice` is `request-changes`.
    - `decision` with options: `choice` with the gate's options, optional, and `note` required when `choice` is empty.
    - `decision` without options: no `choice` field, and `note` required.
    - `assistance`: `choice` option `done`, required, and `note` optional.
20. Applying `gate.answer` records the answer on the gate exactly as the browser answer did, with `before` `null` and `after` `{ choice, note }`, and an answered gate keeps its target and lists `gate.answer` as unavailable with the reason `The question already has an answer.`
21. `index.rebuild` has no fields, `value` `null`, and `revision` `null`, is unavailable with the reason `An index build is already running.` while the indexing state is `preparing`, and starts a rebuild when applied, with `before` `null` and `after` `started`.
    `startReviewServer` takes `rebuildIndex`, the function that starts a rebuild, as `createProjectReview` does.
    The project history record holds `{ schemaVersion: 1, history }`.

### The write credential

22. The apply route refuses a request without a live write session with 403 and `{ code: "write_forbidden", message }`, where `message` is clause 27's notice, and a write session is a token in the `X-Prism-Write` request header that this review server or app issued.
23. When Prism opens a browser itself, for `present_review`, a session start, or `prism review`, the URL it opens is the review URL followed by `#write=<grant>`, where a grant is 32 random bytes in base64url, issued for that open, valid once, and expiring 120 seconds after issue.
    In the shared app, the `present` control answer carries the grant as `writeGrant` when it tells the presenting process to open a browser, and the presenting process adds it to the URL it opens.
24. `POST <base>/api/write-session` with the JSON body `{ grant }` and the origin rule of clause 10 answers 200 with `{ token }`, a new 32-byte base64url write session, and consumes the grant; a used, expired, or unknown grant answers 403 with `{ code: "grant_refused", message }`.
    The page keeps the token in the tab's session storage, which no other tab shares, and removes the fragment from its address without a new history entry, so a tab opened from a URL that an agent handed over has no write session and stays read-only.
25. `writable` in the action listing is `true` only when the request carries a live write session.
26. No tool result, review URL, control answer other than clause 23's, discovery file, or other file that Prism writes holds a grant or a write session token.
    A review server or app keeps only SHA-256 digests of the tokens it issued; the shared app keeps the digests of its newest 100 tokens in its private app directory, readable only by its user, and an app that starts from a handoff in which it reuses the viewer credential accepts them, while an app that starts any other way accepts none.
27. A read-only tab shows the notice `This tab can only read. To make changes, run prism review in this project, or ask the agent to present the review.`, its action controls are disabled, and the same text is the `write_forbidden` message.
28. A viewer stream `GET <base>/api/events?write=<token>` counts as writable when the token is a live write session, and when Prism decides whether to open a browser at a presentation, a session start, or `prism review`, it counts only writable viewer streams of the app, or of the session server in fallback, as connected tabs, keeping every other rule of that decision.

### What the page shows

29. The initiative page and every slice page show a card titled `Initiative settings` that renders every action of the target's listing generically from its fields: `choice` and `toggle` as the existing segmented button group, `text` as the existing text input, the effect sentence under each action, and an unavailable action's reason in place of its control; a slice page's card names the initiative, so the settings read as the initiative's.
30. `actionFormState(action, draft)`, exported by `dist/server/review/public/views/actions.js`, gives the state of one action's control from `draft = { values }`: `{ input, ready, confirm, hint }`, where `input` maps every field to the draft value or else the current value, `ready` is `false` while the action is unavailable, while `input` equals the current value, or while a required field is empty, `confirm` is the confirmation message when clause 3's `confirm` matches `input` and otherwise `null`, and `hint` is the unavailable reason, `Fill in <field label>.` for the first empty required field, or an empty string.
31. Every control is reachable with Tab and works with Enter and Space, a control that needs confirmation opens the page's modal dialog with the confirmation message and the buttons `Confirm` and `Cancel`, where Escape cancels, and the page resends the request with `confirmed: true` only after `Confirm`.
32. On `stale_revision` or `action_unavailable`, the page shows the action from `current`, keeps the person's draft out of it, and shows the toast `Someone changed this since you opened it; it now shows the current value.`
33. The jump palette lists the shown target's available actions as entries labeled `<label>: <value>`, and choosing one moves focus to that action's control.
34. When an action is applied, every connected viewer stream of the action's project receives an `action` event whose data is the history entry with `initiative`, the initiative identifier or `null` for the project history.
35. The Attention entity's data gains `recentChanges`: the newest 20 history entries across every initiative and the project, newest first, each with `initiative`, and the Attention page lists them under `Recent changes` and adds each `action` event at the top without a reload.

### Agents learn of the person's changes

36. A session is the holder that claims use: the host session that the call's metadata or the server's environment names, or else the Prism server process.
37. When a tool call names an initiative in its `initiative` argument and succeeds, and that initiative's history holds entries newer than the newest one this session has been shown, the result's `structuredContent` gains `personChanges`, those entries oldest first, and its content gains a text block that starts `The person changed this initiative in the review app since this session last read it:` and lists one line per entry with its action, target, before and after values, and the action's effect.
    Those entries then count as shown to this session, so no later result of this session repeats them.
38. A session's first successful call that names an initiative shows it nothing and counts every existing entry as shown.
39. What a session was shown is kept in the host's private plugin data folder, so a server that the host restarts in the same session does not show entries again.
40. A `wait_for_user_gate` call ends when an entry is appended to the initiative's history after the call started, other than an answer to one of its gates, and returns `{ status: "changed", gateIds, waiting, changes }`, where `changes` lists those entries, which count as shown; on a host where the Stop hook waits, the hook blocks the stop with clause 37's text for them.
41. When `update_coordination_state` or `checkpoint_pause` names a setting that `personSettings` marks, with another value, the stored value stays, and the result lists `keptSettings: [{ setting, kept, requested }]`.
42. `update_initiative` results of `claim` and `set_status` operations carry `settings`: the seven effective setting values of clause 6 and `personSettings`, the names of the settings the person set.
43. When `accept_proposal` or `accept_design` accepts a design, Prism sets its review mark from the initiative's `review` setting at that moment: `all` marks every accepted design `required`, `recommended` marks `required` each slice that `reviewRequired` names or whose proposed `accept_design` recommended `required`, and `marked` or an unset setting keeps today's marks; an accepted design keeps its mark when the setting changes later.
44. The orchestrate skill acts on `personChanges`, a `changed` gate wait, and `keptSettings` before its next step, applying each change at the effect point its action names.

## Assumptions

- Probed: a write session kept in a tab's session storage from a one-time grant in the URL fragment survives a reload of that tab, is absent from a second tab opened on the same URL in the same browser, and the fragment never reaches the server; after the page replaces its address the tab's URL has no fragment (`node docs/plans/initiative-settings-actions/probes/tab-write-session.mjs`, observed the first tab's two requests with `X-Prism-Write: token-for-G1`, the second tab's request with none, and `afterGrantUrl` without `#write`).
- Unprobed: every platform's browser opener passes the URL fragment to the browser; where one drops it, the tab opens without a write session and shows clause 27's notice, so the person sees why it cannot write rather than a silent failure.
- Unprobed: hosts give child agents the same session identity as their orchestrator, as Codex does for its sub-agents, so a child that calls Prism first is shown the person's changes instead of the orchestrator; clause 42 gives the orchestrator the current settings whenever it claims a scope or starts a slice, and clause 40 ends its gate waits, so a change still reaches it before the next child starts.

## Slices

| Slug | Outcome | Requirements | Depends on | Frozen tests | Review |
| --- | --- | --- | --- | --- | --- |
| `action-registry` | The review app lists and applies revision-checked actions from one transport-independent registry, with the seven initiative settings, gate answers, and the index rebuild as its actions, and records each in history. | `review-app-actions.md§1`-`§7`, `§9`, `§10`; `initiative-settings.md§1`, `§2`, `§3`, `§9` | | `test/server/fixtures/review-actions.mjs`, `test/server/review-actions.test.mjs` | required: the single write path of the person's authority over untrusted page input |
| `write-credential` | Only a tab that Prism opened can apply actions, through a one-time grant exchanged for a per-tab write session that no agent-visible surface reveals, on the shared app and the per-project session server. | `review-app-actions.md§11`, `§12` | `action-registry` | `test/server/review-write-credential.test.mjs` | required: authentication and secret handling |
| `action-controls` | The initiative and slice pages render every action generically as compact keyboard-reachable controls with confirmation and stale handling, read-only tabs say why, and every tab's Attention page shows applied actions as they happen. | `review-app-actions.md§1`, `§2`, `§5`, `§8`; `initiative-settings.md§1`, `§9` | `write-credential` | `test/server/review-action-controls.test.mjs` | none |
| `agent-change-notices` | Running agents learn of the person's changes once per session from Prism's tool results and gate waits, keep the person's settings over their own, and apply the review policy at design acceptance. | `review-app-actions.md§13`, `§14`; `initiative-settings.md§3`-`§8` | `action-registry` | `test/server/agent-change-notices.test.mjs` | required: keeps agents from overriding the person's push and commit settings |

The overview is [overview.puml](overview.puml).
