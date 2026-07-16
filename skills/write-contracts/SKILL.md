---
name: write-contracts
description: Author or update a track's contracts in the plans directory — boundary interfaces/types, no implementations, ADR-cited. Use when pinning a track's shapes before implementation.
argument-hint: [initiative/track]
---

# Write contracts

Contracts are the **shapes** of a feature: the interfaces and types that cross
module boundaries, written before any implementation. They are the structural half
of the implementation handoff — contracts pin *structure*, feature files pin
*behavior*. One of three prep-bundle artifacts under the plans directory (default
`/docs/plans/<initiative>/<track>/`).

Project settings for this workflow live in `.claude/workflow-config.md` at the
project root (created by the `workflow-init` skill). Read it first if it exists;
it names the project's language and paths and overrides the defaults below.

Writing contracts is **itself a design check**: types force under-specification into
the open. If a shape is hard to name or a field's meaning is unclear, the design is
not settled — feed that back to the ADR. This is why contracts may *lead* the build plan.

The discipline applies to **any typed boundary** — the contracts file is written
in the project's language (workflow-config names it: TypeScript, Rust, Python with
type hints, Go, …). The worked example below is TypeScript; translate the
conventions to the project's idioms (e.g. `Result<T>` → `Result<T, E>` in Rust,
`Optional`/union types in Python). Contracts follow the project's code-style
rules. They are **boundary types only**: interfaces, type aliases, discriminated
unions, signatures. **No implementations** — no function bodies, no classes with
logic, no runtime validation schemas. Where a value will be validated, a
doc-comment says so; it does not contain the validator.

Before writing, read the project glossary, the governing ADR(s), and the feature
files you are pairing with.

---

## Where it lives

`<plans-dir>/<initiative>/<track>/contracts.ts` (extension per the project's
language), alongside `build-plan.md` and `handoff.md`. It is **scratch** — the
durable version is the real interfaces the implementer writes into the codebase.
So it may redeclare existing repo types locally (see below) without colliding
with anything shipped.

---

## Structure (worked example: TypeScript)

```typescript
/**
 * <Feature> — contracts.
 *
 * Source-of-truth precedence: ADR > this file > build plan > feature files.
 * Conventions: boundary interfaces (not classes), `Result<T>` for expected
 * failures, domain aliases over primitives, `readonly` on contract shapes. Where
 * a type is validated at a boundary, a doc-comment says so.
 */

// Local re-declarations of existing repo types, so this file type-checks in
// isolation. These are NOT new types — they mirror what already exists.
type Result<T> = ...

// → src/<dest>/<file>.ts
// <One line on this section's role.>
export interface NotificationRouter { ... }
```

Group types into sections, each headed by a `// → destination/path.ts` comment plus
a one-line role description. The section header tells the implementer where the
shape lands.

---

## Conventions

- **Interface at the boundary, not a concrete class.** Inject behind an interface;
  the implementation is the module's business.
- **Domain aliases over primitives** (`type ChannelId = string`), never `enum`.
- **`T | null` for deliberately-unknown; `field?:` for may-be-absent.** They mean
  different things — use them deliberately and consistently.
- **`readonly` / `ReadonlyArray`** (or the language's immutability idiom) on
  immutable contract shapes.
- **`Result<T>` for expected failures**, never `throw`, at the boundary.
- **Named, exported types** — no inline anonymous object types at the boundary.
- **Doc-comment every type with its ADR section** (`ADR 30 §Artifact manifest`),
  never a plan track. Explain wire semantics and any cross-field invariant
  ("MUST match the enclosing directory name; checked at install").
- **Flag deferred shape decisions with `// OPEN:`** — where the ADR leaves a wire
  shape unspecified, name the gap and leave it for the implementer to resolve and
  confirm, rather than guessing.
- **Call out defined seams** ("a DEFINED SEAM", "RESERVED — not implemented here")
  so the reader knows what is an injection point versus future work.

(Where the project has its own authoritative code-style rules, apply them here too.)

---

## Quality checks before finishing

- No implementations leak in — no function bodies, logic-bearing classes, or
  runtime validation schemas.
- Every section has a `// → path` destination header.
- Every type carries an ADR-cited doc-comment; no plan-track references.
- `T | null` vs optional is used deliberately, not interchangeably.
- Under-specified shapes are marked `// OPEN:`, not silently invented.
- The file type-checks in isolation (local re-declarations cover repo types).
