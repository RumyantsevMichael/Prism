# Session store safety

Status: Approved
Created: 2026-10-12
Approved: 2026-10-12

## Problem

The session trace store and the host-session fact store implement the same private, locked file store twice.
Both files define `acquireLock`, `readLockOwner`, `createOwnedLock`, `inspectLockPath`, `inspectRegularFile`, `openExistingRegularFile`, and their directory checks.
The copies have drifted: `MAX_LOCK_OWNER_BYTES` has different values, and one `readLockOwner` throws where the other returns `null`.
A change to path safety or locking must be made twice, and a missed copy weakens a security boundary.

## Goals

- Keep one implementation of the path checks and the retention lock that both stores use.
- Keep the observable behavior of both stores.

## Non-goals

- Change what either store records.
- Change retention limits, error codes, or lock protocols.
- Add new user-facing behavior.

## Design questions

- n/a.

<a id="1"></a>
## 1. Share one store safety unit

Pattern: Ubiquitous

Disposition: Active

Requirement: The session trace store and the host-session fact store shall use one shared unit for direct-child path checks, symbolic-link rejection, no-follow opens, private file creation, and the retention lock.

Rationale: One implementation of a security boundary cannot drift between copies.

Related: [session-store-safety.md§2](#2)

<a id="2"></a>
## 2. Preserve store behavior

Pattern: Ubiquitous

Disposition: Active

Requirement: Each session store shall keep its current observable behavior, including its error codes, lock protocol, size limits, and record formats.

Rationale: The consolidation changes structure only, so existing callers and stored records keep working.

Related: [session-store-safety.md§1](#1)
