---
name: write-step-definitions
description: Write or update BDD acceptance step definitions wiring Gherkin feature files to executable assertions. Use when implementing a feature file or connecting Gherkin steps to test code.
---

# Write Step Definitions

Step definitions are the translation layer between domain language in feature
files and the mechanical test infrastructure. They are where implementation
knowledge lives — class names, field paths, internal identifiers. Feature files
must remain clean of this knowledge; step definitions embrace it.

Project settings for this workflow live in `.claude/workflow-config.md` at the
project root (created by the `workflow-init` skill). Read it first if it
exists; it names the test runner, BDD harness, and acceptance-test location.
If absent, use the defaults below and the project's own CLAUDE.md conventions.

Before writing, read in order:
1. The feature file being implemented — understand every step's domain meaning
2. The glossary (default `/docs/Glossary.md`) — find the mechanical meaning of
   domain terms
3. Relevant ADRs — understand what each domain concept means structurally
4. The project's existing test helpers (e.g. `tests/helpers/`) — check what
   exists before writing new ones

---

## Setup — what the harness must achieve

The workflow-config names the BDD harness (cucumber-js, pytest-bdd,
bun-test-cucumber, behave, …) and how acceptance tests run. Whatever the
harness, setup must achieve the same things:

- Feature files and step definitions are both discovered by the project's
  normal test command — running acceptance tests should not need a separate,
  undocumented invocation.
- Steps share **typed, per-scenario state**: initialized fresh before each
  scenario, mutated by steps, never leaked between scenarios.
- The wiring (plugin registration, preload, conftest, hooks) is committed and
  idempotent, so any session can run the suite without ritual.

If the harness is not yet wired in this project, wire it once, commit the
configuration, and record the invocation in the workflow-config.

---

## State between steps — typed state object

Whatever the harness's mechanism (a World class, a fixture, a generic state
parameter), model scenario state as one explicitly-typed object: define the
state type per step file, initialize every field in a before-scenario hook,
and have steps read and mutate that object — never module-level mutable
globals.

### Example stack: Bun + @aboviq/bun-test-cucumber

*One worked example — the same discipline applies unchanged under
cucumber-js's World, pytest-bdd fixtures, or any other harness.*

`@aboviq/bun-test-cucumber` integrates Cucumber with Bun's native test runner
(tests run with `bun test`; setup installs the package, registers a test
plugin file, and adds a `[test] preload` entry to `bunfig.toml`). It does not
use the `this` World pattern — state is a plain typed object passed through
generics:

```typescript
import { given, when, then, before } from '@aboviq/bun-test-cucumber';
import { expect } from 'bun:test';
import { OrderService } from '../../src/orders/order-service.ts';
import { InMemoryOrderStore } from '../helpers/in-memory-order-store.ts';
import type { ShipmentNotice } from '../../src/orders/types.ts';

// State shared across steps within one scenario
type OrderState = {
  service: OrderService;
  store: InMemoryOrderStore;
  currentOrderId: string | null;
  shipmentNotice: ShipmentNotice | null;
};

// Initialize clean state before each scenario
before<OrderState>(() => ({
  service: new OrderService(new InMemoryOrderStore()),
  store: new InMemoryOrderStore(),
  currentOrderId: null,
  shipmentNotice: null,
}));

given<OrderState>('a paid order that has not shipped', (state) => {
  state.currentOrderId = state.service.createPaidOrder();
});

when<OrderState>('the customer requests cancellation', async (state) => {
  await state.service.requestCancellation(state.currentOrderId!);
});

then<OrderState>('the order is cancelled', (state) => {
  expect(state.service.status(state.currentOrderId!)).toBe('cancelled');
});
```

The `before` hook initializes state once per scenario. Steps receive and
mutate the same state object.

---

## Translating domain language to mechanics

Read the Gherkin step, find its domain meaning in the glossary, then find its
mechanical meaning in the ADRs.

| Domain language (feature file) | Mechanical meaning (step definition) |
|---|---|
| "a paid order that has not shipped" | Order record exists with payment captured, no shipment record |
| "the order is marked as shipped" | Order status transitions to the shipped state and a shipment record exists |
| "the customer is notified that the order shipped" | The notification spy recorded a shipment notice for the order's customer |
| "a return request is opened" | The returns store contains a new open request referencing the order |

Always derive the mechanical meaning from the ADR and glossary, not from
reading existing test code directly. Existing tests may not reflect the settled
design.

---

## Driving the system under test

Many When steps require driving the system — running a loop, processing a
queue, advancing a workflow. Put that drive logic in shared helpers (e.g.
`tests/helpers/`), not inline in step definitions:

- If the system runs continuously, give tests a clean termination mechanism —
  a sentinel error or stop condition defined **once** in a shared helper and
  imported everywhere (an `instanceof` check depends on reference equality of
  the class, so never redefine it per file).
- Provide named helpers for common drive patterns ("run until the handoff",
  "process exactly N events") and add new ones to the helper module when a
  pattern repeats.

---

## Spy helpers

Step definitions need to observe internal events described in domain language.
Use spy factories that record what they observe without changing behavior —
thin wrappers around the real component that capture calls into scenario state:

```typescript
export function createSpyNotifier(opts: {
  onShipmentNotice?: (notice: ShipmentNotice) => void;
}): Notifier {
  // ... thin wrapper around the real notifier
}
```

Keep spy factories in the shared helpers directory, one per component type,
reused across all step files.

---

## Then step discipline

Then steps assert observable outcomes. Keep them focused:

- Assert the minimum that proves the step's domain claim
- Do not assert internal field paths unless they are directly implied by the
  domain step wording
- One logical assertion per Then step

**Appropriate:**
```typescript
then<OrderState>('the order is marked as shipped', (state) => {
  expect(state.service.status(state.currentOrderId!)).toBe('shipped');
});
```

**Over-specified:**
```typescript
then<OrderState>('the order is marked as shipped', (state) => {
  expect(state.store.get(state.currentOrderId!)?.fulfillment.state).toBe('shipped');
  expect(state.store.get(state.currentOrderId!)?.fulfillment.carrier).toBe('default');
  expect(state.store.get(state.currentOrderId!)?.version).toBe(1);
});
```

---

## Step reuse across feature files

Define steps that apply broadly in a shared steps module (e.g.
`tests/acceptance/shared/common.steps.ts`). Import from there in
feature-specific step files.

Do not copy-paste step definitions between files. If a step appears in two
files, it belongs in shared.

---

## Quality checks before finishing

- Every step in the feature file has a matching step definition
- No domain-language steps directly assert internal field paths
- State type is defined and initialized in a before-scenario hook
- Spy helpers live in the shared helpers directory, not inlined in step files
- System-drive logic uses shared helpers, not inline wiring
- Shared steps live in the shared steps module, not duplicated
- The step file is named to match its feature file (e.g. `F-<slug>.steps.ts`)
- The BDD harness is wired so the project's normal test command runs the
  acceptance suite
