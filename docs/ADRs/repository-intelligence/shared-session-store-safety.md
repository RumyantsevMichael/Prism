# Share one safety unit between the session stores

Status: Accepted
Created: 2026-10-12

## Requirements

[Share one store safety unit](../../requirements/session-store-safety.md#1) requires one implementation of the path checks and the retention lock for both session stores.
[Preserve store behavior](../../requirements/session-store-safety.md#2) requires each store to keep its error codes, lock protocol, size limits, and record formats.

## Problem

The session trace store and the host-session fact store each contain a private copy of the same file-store safety boundary.
The copies have drifted in the lock owner size limit and in how they treat an invalid lock owner.
The current values of these differences are observable store behavior that must stay the same.
A security correction applied to one copy does not reach the other copy.

## Decision

The session trace store and the host-session fact store MUST get their store directory checks, direct-child checks, symbolic-link and hard-link rejection, no-follow opens, private file creation, and retention lock from one shared unit.
A store MUST NOT keep its own copy of these checks.
Each store MUST give the shared unit its directory name, its unsafe-path error code, its lock owner size limit, and its lock protocol.
The shared unit MUST report an unsafe path with the error code that the calling store supplies.
The shared unit MUST support two lock protocols: direct publication and staged publication.
Direct publication MUST create the public lock directory before the owner record and MUST treat an invalid owner record as an unsafe path.
Staged publication MUST prepare the owner record in a private pending directory, MUST publish it by rename, and MUST treat an invalid owner record as an absent owner.
Both protocols MUST use one owner record format, one stale age, and one retry count.
The shared unit MUST apply the owner size limit that the calling store supplies.
The session trace store MUST use direct publication with a 256-byte owner limit.
The host-session fact store MUST use staged publication with a 128-byte owner limit.

## Rationale

One shared unit makes a path-safety or lock correction apply to both stores at the same time.
The two stores use different directories, so each store can keep its current lock protocol without a cross-store compatibility change.
Store configuration keeps the remaining differences visible in one place instead of in two diverging copies.

## Alternatives

### Move both stores to staged publication

Declined because the requirement keeps each store's current lock protocol and the trace store reports a different reason code for an invalid owner.
Two plugin versions can also use one store directory at the same time during an update.
A staged rename replaces an empty lock directory that direct publication has just created, so mixed protocols in one store would let two holders own the lock.
A protocol change for one store therefore needs a migration that keeps old and new versions mutually exclusive.

### Use one owner size limit for both stores

Declined because the requirement keeps each store's size limits, and a padded owner record that the trace store accepts today would become invalid.

### Share only the path checks

Declined because the retention lock contains the larger part of the duplicated security boundary.

### Keep two copies and add a parity test

Declined because a test can detect drift only for the cases that it covers.

## Consequences

A change to the shared unit changes the safety boundary of both stores and needs tests for both stores.
The lock owner size limit stays a per-store value, so the shared unit does not remove that drift by itself.
The two lock protocols and the two owner limits stay different until a requirement change unifies them.

## Mechanism

Each store creates one configured safety instance when its module loads.
The instance resolves the store directory below the canonical plugin data directory and checks it again before each mutation.
The instance opens existing records only after it confirms one link, a regular file, and a direct child of the store directory.
The instance creates records and lock owners with exclusive no-follow opens and private permissions.
The instance acquires, checks, and releases the retention lock through the configured protocol.

## Decision Log

2026-10-12: Proposed one shared safety unit that keeps each store's lock protocol.
2026-10-14: Accepted after implementation verification, with the mixed-version lock risk as the reason to keep each store's protocol.
