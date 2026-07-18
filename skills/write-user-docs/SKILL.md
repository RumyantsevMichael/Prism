---
name: write-user-docs
description: Write or update user-facing docs in the project's user guide (default /docs/user-guide/). Use when a change alters observable product behavior — commands, config, ports, defaults, capabilities.
---

# Write user docs

The user guide (default `/docs/user-guide/`) is the source-of-truth for how
people **install, configure, and use** the product. It is written for someone
running and using it — not for someone building it. Keeping it current is a
continuous obligation: a change that alters observable behavior is not done
until the user guide reflects it.

Project settings for this workflow live in `.claude/workflow-config.md` at the
project root (created by the `workflow-init` skill). Read it first if it
exists — it overrides the default paths and stack assumptions below. If
absent, use the defaults and the project's own CLAUDE.md conventions. The
session map and lifecycle rules live in the `workflow` overview skill.

Before writing, read:

1. The user guide's `README.md` — the index, the maturity disclaimer, and the
   page map. Match its structure and tone. The index is expected to carry a
   maturity disclaimer: a user guide should state plainly how mature and
   complete the product is. If one is missing, add it.
2. The specific page(s) you're changing, plus any sibling page they cross-link.
3. The glossary (default `/docs/Glossary.md`) — use terms exactly as defined
   there; do not coin user-facing synonyms for established concepts.

---

## What belongs here (and what does not)

**Belongs in the user guide:** how to install and run the product; what each
interface is and how to reach it; configuration keys, defaults, ports, and file
locations; what capabilities exist; what is planned. Things a user observes or
sets.

**Does NOT belong here:** internal architecture, module boundaries, the reasons
behind a design, invariants, test strategy, or implementation detail. Those live
in the ADRs, feature files, glossary, and architecture docs. Link to them; do
not copy them in.

Diagnostic: if a sentence would only make sense to someone editing the codebase,
it belongs in the developer docs, not here.

---

## Core rules

1. **Honesty about maturity is non-negotiable.** Describe what *runs today*
   plainly. Mark anything not yet shipped as **Planned** — never document a
   feature as available before it ships. When unsure whether something works,
   verify against the implementing module in the source tree before claiming
   it.

2. **One source of truth per fact.** Ports, defaults, and paths come from the
   authoritative config module or ADR — restate them only where a user needs
   them, and when they change, change them here too. Prefer linking the
   authoritative internal doc over duplicating rationale.

3. **Keep it rough-but-correct.** This guide is a seed that evolves. A short,
   accurate page beats a long, speculative one. Don't invent workflows that
   don't exist to fill a section; leave a brief **Planned** note instead.

4. **Update cross-links and the index.** When adding or renaming a page, update
   `README.md`'s page map and any in-text links between pages.

5. **Match the established voice.** Second person ("you run", "the product
   remembers"), present tense for what exists, plain language, minimal jargon.
   Lead each page with a one-line status/scope note when it helps the reader.

---

## Voice & style

Write for a reader who is smart but not inside the system. Lead with a plain,
everyday framing — reach for an analogy — and only **then** name the precise
term. Jargon first is the failure mode; the term should land *after* the reader
already understands the thing.

For any concept, cover three things:

1. **What it is** — in plain words, ideally via an analogy ("the service's
   identity is its *passport*").
2. **Why it matters to you** — the consequence the reader actually cares about.
3. **How often it changes** — for anything stateful, say it explicitly, and
   **distinguish the long-lived thing from the per-event thing** when both exist.
   Conflating a stable identity with a fresh-each-time proof is the usual
   confusion, so separate them on purpose ("the identity should change
   essentially never; the proof is regenerated every connection by design").

Explain a security or behavioral consequence in human terms, not mechanism
("a service showing up with a different key is, to your devices,
indistinguishable from an impostor — so they refuse to talk to it until you
re-pair").

Keep the rigor available but **secondary**: cite the precise term, the glossary
entry, or the ADR **after** the plain explanation, as the paper trail — never in
place of it.

**Before / after:**

> ✗ The service presents its long-lived ed25519 identity key plus a
> per-connection signature over the channel-binding nonce.

> ✓ Each service has a permanent identity — think of it as a passport that
> should essentially never change. On top of that, every time a device
> connects, the service produces a fresh signature, like signing a one-time note
> to prove it's really holding the passport. Your devices remember the passport;
> a service showing up with a different one looks like an impostor, so they
> refuse it until you re-pair. (Identity and per-connection proof; see the
> relevant ADR.)

Existing pages migrate to this voice as they're touched — this is not a
call to rewrite the guide in one pass.

---

## When a code change triggers a doc update

If a change adds or alters an observable surface — an interface, a command or
subcommand, a port, a config key or default, a secret/file location, or a
user-visible capability — update the matching page in the same change. Map the
change to the guide's own page structure; a typical layout:

| Change | Page to update |
|---|---|
| How the product is installed or started | `getting-started.md` |
| A config key, default, port, or file/secret location | `configuration.md` |
| A UI, API, or CLI surface | `interfaces.md` |
| A new/removed capability | the relevant capability/concepts page |
| Something moving from planned to available | `roadmap.md` (+ the relevant page) |

If a capability moves from **Planned** to **available**, remove the Planned
marker on the relevant page and the entry from any "Planned" list in the same
change.

---

## File format

Plain Markdown, one topic per file, under the user-guide directory. Start a
page with a short blockquote status/scope note. Use tables for ports/defaults
and cross-link related pages at the foot of each page. No build step, no
website — just Markdown, unless the workflow-config says otherwise.
