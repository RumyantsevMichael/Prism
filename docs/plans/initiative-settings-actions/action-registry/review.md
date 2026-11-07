# Slice review

This file is a generated view of review.json.

## implementation-review: wave-1

Verified tree: a9eeef1341bfd7a1afb79921682917ea4b23aeef
Base: 15e583d

- correctness: FINDINGS (reviewer-ar-correctness-1)
- security: FINDINGS (reviewer-ar-security-1)

## implementation-review: wave-2

Verified tree: 6a8fc8140e48e12d7117b100ffbb553ee1bb92ac
Base: 15e583d

- correctness: CLEAN (reviewer-ar-correctness-2)
- security: CLEAN (reviewer-ar-security-2)

## implementation-review/security/SEC-1: A refused apply on an initiative or slice target writes to the record store before its checks run

- Status: VERIFIED
- Severity: low
- Evidence: recordPersonAction runs moveLegacyRecords(projectRoot) and mkdir of the state directory before prepare() repeats the revision, availability, input, and confirmation checks under the lock, so a request that is then refused has already migrated any legacy records and created the initiative's state directory. Probe: in the review-actions fixture with gates:false, three refused applies on initiative:search (invalid_input 400, stale_revision 409, confirmation_required 409) each left .prism/initiatives/search/ created where it did not exist before. Clause 13 says the first refusal changes no record and runs nothing.
- Condition to close: An apply on an initiative, slice, or gate target that is refused with stale_revision, action_unavailable, invalid_input, or confirmation_required leaves the record store byte-for-byte and entry-for-entry unchanged (no new directory, no legacy move), shown by a test that lists the record store before and after such refusals on an initiative that has a roadmap entry but no coordination state.
- Implementer evidence: 4fa6e57: checks run on the state as read before any disk write; refusals and unchanged applies leave the .prism tree untouched (review-action-refusals.test.mjs).

## implementation-review/security/SEC-2: The apply route accepts any Content-Type that starts with application/json

- Status: VERIFIED
- Severity: low
- Evidence: fromPage() tests String(content-type).startsWith("application/json"), so application/json-seq, application/jsonx, or application/json-patch+json pass the check and reach the registry. Probe: POST api/actions/apply with Content-Type application/json-seq answered 404 unknown_target from the registry instead of 403 origin_refused. Clause 12 refuses a request whose Content-Type is not application/json; the media type should be compared exactly, parameters such as charset aside.
- Condition to close: fromPage compares the media type (the part before any ';', trimmed and lower-cased) to exactly application/json, and a test shows application/json-seq answers 403 origin_refused while application/json; charset=utf-8 is accepted.
- Implementer evidence: 4fa6e57: apply accepts only the media type application/json with parameters; json-seq and similar get 403 origin_refused (review-action-refusals.test.mjs).

## implementation-review/correctness/ar-c-1: An unchanged models assignment stored in another key order is applied as a change

- Status: VERIFIED
- Severity: medium
- Evidence: check() compares JSON.stringify(after) with JSON.stringify(current.value), so a stored models object such as { review, delivery, securityReview } (accepted by update_coordination_state) never equals the registry's { delivery, review, securityReview } for the same roles. Applying the same assignment writes a history entry and a personSettings.models mark instead of answering applied: null, which also marks the setting as the person's for later agent-change rules. test/server/review-action-equal-models.test.mjs fails: applied is an entry, not null.
- Condition to close: test/server/review-action-equal-models.test.mjs passes: applying an input equal to the current models value in any key order answers applied: null and writes no history or personSettings.
- Implementer evidence: ebc8c5f compares setting values by content, so key order is no change; test/server/review-action-equal-models.test.mjs passes.

## implementation-review/correctness/ar-c-2: A host defaults models input is refused for text fields it should ignore

- Status: VERIFIED
- Severity: low
- Evidence: readInput checks every text field's 200-character limit before after() runs, so applying initiative.models with mode 'host defaults' and a delivery of 300 characters answers invalid_input on delivery, although clause 9 says applying host defaults stores host defaults and ignores the text fields (observed in a probe against dist/server/workflow/actions.mjs: 'host defaults refused invalid_input delivery').
- Condition to close: Applying initiative.models with mode 'host defaults' stores 'host defaults' whatever the text fields hold, and a test asserts it.
- Implementer evidence: 4fa6e57: models mode host defaults ignores text fields and stores host defaults; covered in test/server/review-action-refusals.test.mjs.

