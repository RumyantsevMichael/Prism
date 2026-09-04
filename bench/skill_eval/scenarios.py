"""Hidden direct-evaluation scenarios for the write-adr skill."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


AssertionKind = Literal[
    "changed_paths_exact",
    "file_appended",
    "file_contains",
    "file_not_contains",
    "file_unchanged",
    "glob_count",
    "output_contains",
    "path_absent",
    "path_exists",
]


@dataclass(frozen=True)
class Assertion:
    """One mechanical check against the completed workspace or agent output."""

    kind: AssertionKind
    target: str
    value: str | int | tuple[str, ...] | None = None


@dataclass(frozen=True)
class Scenario:
    """One isolated write-adr invocation and its hidden expected result."""

    id: str
    prompt: str
    workspace_files: dict[str, str]
    assertions: tuple[Assertion, ...]


WORKFLOW_DEFAULT = """# Workflow

Approved requirements live in `docs/requirements/`.
Architecture decision records use the default location.
"""

WORKFLOW_CONFIGURED = """# Workflow

Approved requirements live in `product/requirements/`.
Architecture decision records live in `architecture/decisions/`.
"""

APPROVED_REQUIREMENT = """# Tenant isolation

Status: Approved

The service MUST keep each tenant's data in a tenant-specific storage boundary.
"""

ADR_STRUCTURE = (
    r"(?ms)^## Requirements$.*^## Problem$.*^## Decision$.*^## Rationale$.*"
    r"^## Alternatives$.*^## Consequences$.*^## Mechanism$.*^## Decision Log$"
)

ACCEPTED_STORAGE_ADR = """# Use tenant-specific databases

Status: Accepted
Created: 2026-08-20

## Requirements

[Tenant isolation](../../requirements/tenant-isolation.md)

## Problem

The service needs a durable tenant isolation boundary.

## Decision

Each tenant MUST use a tenant-specific database.

## Rationale

Database boundaries limit accidental cross-tenant access.

## Alternatives

A shared schema was rejected because filters can be omitted.

## Consequences

Isolation improves, but database operations become more expensive.

## Mechanism

Tenant routing selects the tenant-specific database before data access.

## Decision Log
"""

PROPOSED_EVENTS_ADR = """# Publish domain events

Status: Proposed
Created: 2026-08-25

## Requirements

[Audit delivery](../../requirements/audit-delivery.md)

## Problem

Audit consumers need reliable change notifications.

## Decision

Services MUST publish domain events after committed changes.

## Rationale

Committed events prevent notifications for rolled-back changes.

## Alternatives

Direct callbacks were rejected because they couple services.

## Consequences

Consumers decouple, but event operations add overhead.

## Mechanism

Each service publishes after its transaction commits.

## Decision Log
"""

ACCEPTED_RETRY_ADR = """# Retry delivery indefinitely

Status: Accepted
Created: 2026-08-21

## Requirements

[Audit delivery](../../requirements/audit-delivery.md)

## Problem

Audit events can fail during delivery.

## Decision

The delivery system MUST retry failed audit events without a retry limit.

## Rationale

No audit event can be discarded.

## Alternatives

A dead-letter queue was rejected because it needs operator recovery.

## Consequences

Events remain durable, but poison events can block delivery.

## Mechanism

The delivery system retries the oldest failed event.

## Decision Log
"""

AUDIT_REQUIREMENT = """# Audit delivery

Status: Approved

The system MUST preserve every committed audit event until delivery succeeds.
"""


SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        id="stop-code-level-helper",
        prompt=(
            "Invoke only write-adr. Create an ADR for choosing a private helper named "
            "parseHeaders inside the request adapter. Use 2026-09-03 as today's date."
        ),
        workspace_files={".prism/workflow.md": WORKFLOW_DEFAULT},
        assertions=(
            Assertion("changed_paths_exact", "", ()),
            Assertion("glob_count", "docs/ADRs/**/*.md", 0),
            Assertion("output_contains", "", r"(?i)(not an ADR|not architectural|code-level|private helper)"),
        ),
    ),
    Scenario(
        id="stop-approved-requirement-conflict",
        prompt=(
            "Invoke only write-adr. Record a decision that all tenants MUST share one database "
            "and one schema. Use 2026-09-03 as today's date."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW_DEFAULT,
            "docs/requirements/tenant-isolation.md": APPROVED_REQUIREMENT,
        },
        assertions=(
            Assertion("changed_paths_exact", "", ()),
            Assertion("file_unchanged", "docs/requirements/tenant-isolation.md"),
            Assertion("glob_count", "docs/ADRs/**/*.md", 0),
            Assertion("output_contains", "", r"(?i)(conflict|contradict).*(approved|requirement)"),
        ),
    ),
    Scenario(
        id="create-default-location",
        prompt=(
            "Invoke only write-adr. Create an ADR for the lasting rule that tenant exports MUST "
            "use tenant-specific encryption keys. Link the Approved tenant isolation requirement. "
            "Write exactly docs/ADRs/tenant-isolation/tenant-export-encryption.md. "
            "Use 2026-09-03 as today's date."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW_DEFAULT,
            "docs/requirements/tenant-isolation.md": APPROVED_REQUIREMENT,
        },
        assertions=(
            Assertion("changed_paths_exact", "", ("docs/ADRs/tenant-isolation/tenant-export-encryption.md",)),
            Assertion("file_contains", "docs/ADRs/tenant-isolation/tenant-export-encryption.md", r"(?m)^Status: Proposed$"),
            Assertion("file_contains", "docs/ADRs/tenant-isolation/tenant-export-encryption.md", r"tenant-isolation\.md"),
            Assertion("file_contains", "docs/ADRs/tenant-isolation/tenant-export-encryption.md", ADR_STRUCTURE),
            Assertion("file_not_contains", "docs/ADRs/tenant-isolation/tenant-export-encryption.md", r"parseHeaders|\.py|\.ts"),
        ),
    ),
    Scenario(
        id="create-configured-location",
        prompt=(
            "Invoke only write-adr. Create an ADR for the lasting rule that tenant backups MUST "
            "use separate encryption domains. Link the Approved requirement. Use 2026-09-03 as today's date."
            " Write exactly architecture/decisions/tenant-backup-encryption.md."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW_CONFIGURED,
            "product/requirements/tenant-isolation.md": APPROVED_REQUIREMENT,
        },
        assertions=(
            Assertion("changed_paths_exact", "", ("architecture/decisions/tenant-backup-encryption.md",)),
            Assertion("file_contains", "architecture/decisions/tenant-backup-encryption.md", r"(?m)^Status: Proposed$"),
            Assertion("file_contains", "architecture/decisions/tenant-backup-encryption.md", r"tenant-isolation\.md"),
            Assertion("file_contains", "architecture/decisions/tenant-backup-encryption.md", ADR_STRUCTURE),
        ),
    ),
    Scenario(
        id="edit-proposed-directly",
        prompt=(
            "Invoke only write-adr. Revise the Proposed domain-events ADR so the invariant says "
            "services MUST publish through a durable outbox after commit. Preserve its status. "
            "Publication order is material and requires a sequence diagram exactly at "
            "docs/ADRs/events/domain-events.puml. "
            "Use 2026-09-03 as today's date."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW_DEFAULT,
            "docs/requirements/audit-delivery.md": AUDIT_REQUIREMENT,
            "docs/ADRs/events/domain-events.md": PROPOSED_EVENTS_ADR,
        },
        assertions=(
            Assertion("changed_paths_exact", "", (
                "docs/ADRs/events/domain-events.md",
                "docs/ADRs/events/domain-events.puml",
            )),
            Assertion("file_contains", "docs/ADRs/events/domain-events.md", r"(?i)durable outbox"),
            Assertion("file_contains", "docs/ADRs/events/domain-events.md", r"(?m)^Status: Proposed$"),
            Assertion("file_not_contains", "docs/ADRs/events/domain-events.md", r"(?m)^Status: Accepted$"),
            Assertion("file_contains", "docs/ADRs/events/domain-events.md", r"\[[^]]+\]\(domain-events\.puml\)"),
            Assertion("file_contains", "docs/ADRs/events/domain-events.puml", r"(?i)commit[\s\S]*(outbox|pending event|publisher)[\s\S]*publish"),
        ),
    ),
    Scenario(
        id="append-accepted-decision-log",
        prompt=(
            "Invoke only write-adr. Clarify the Accepted tenant database ADR without changing its "
            "meaning. Record that read replicas may share infrastructure when tenant database "
            "boundaries remain intact, and explain that this reduces idle capacity. "
            "Use 2026-09-03 as today's date."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW_DEFAULT,
            "docs/requirements/tenant-isolation.md": APPROVED_REQUIREMENT,
            "docs/ADRs/storage/tenant-databases.md": ACCEPTED_STORAGE_ADR,
        },
        assertions=(
            Assertion("changed_paths_exact", "", ("docs/ADRs/storage/tenant-databases.md",)),
            Assertion("file_appended", "docs/ADRs/storage/tenant-databases.md"),
            Assertion("file_contains", "docs/ADRs/storage/tenant-databases.md", r"(?m)^Status: Accepted$"),
            Assertion("file_contains", "docs/ADRs/storage/tenant-databases.md", r"2026-09-03"),
            Assertion("file_contains", "docs/ADRs/storage/tenant-databases.md", r"(?i)read replicas.+tenant.+boundar"),
            Assertion("file_contains", "docs/ADRs/storage/tenant-databases.md", r"(?i)idle(?:\s+\w+){0,3}\s+capacity"),
        ),
    ),
    Scenario(
        id="supersede-accepted-adr",
        prompt=(
            "Invoke only write-adr. Replace indefinite retries with a lasting rule that failed audit "
            "events MUST move to a durable dead-letter queue after five attempts. Operators MUST "
            "approve replay. This contradicts the Accepted retry ADR, so record the supersession. "
            "The retry and dead-letter lifecycle is material and requires a PlantUML lifecycle diagram. "
            "Write the new ADR exactly at docs/ADRs/events/dead-letter-after-five-attempts.md. "
            "Write the diagram exactly at docs/ADRs/events/dead-letter-after-five-attempts.puml. "
            "Use 2026-09-03 as today's date."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW_DEFAULT,
            "docs/requirements/audit-delivery.md": AUDIT_REQUIREMENT,
            "docs/ADRs/events/indefinite-retries.md": ACCEPTED_RETRY_ADR,
        },
        assertions=(
            Assertion("changed_paths_exact", "", (
                "docs/ADRs/events/dead-letter-after-five-attempts.md",
                "docs/ADRs/events/dead-letter-after-five-attempts.puml",
                "docs/ADRs/events/indefinite-retries.md",
            )),
            Assertion("glob_count", "docs/ADRs/events/*.md", 2),
            Assertion("file_contains", "docs/ADRs/events/indefinite-retries.md", r"(?m)^Status: Superseded$"),
            Assertion("file_contains", "docs/ADRs/events/indefinite-retries.md", r"\[[^]]+\]\([^)]+\.md\)"),
            Assertion("file_contains", "docs/ADRs/events/dead-letter-after-five-attempts.md", r"(?m)^Status: Proposed$"),
            Assertion("file_contains", "docs/ADRs/events/dead-letter-after-five-attempts.md", r"(?i)dead-letter"),
            Assertion("file_contains", "docs/ADRs/events/dead-letter-after-five-attempts.md", r"\[[^]]+\]\(indefinite-retries\.md\)"),
            Assertion("file_contains", "docs/ADRs/events/dead-letter-after-five-attempts.md", r"\[[^]]+\]\(dead-letter-after-five-attempts\.puml\)"),
            Assertion("file_contains", "docs/ADRs/events/dead-letter-after-five-attempts.puml", r"(?im)^@startuml\b[\s\S]*^@enduml\b"),
            Assertion("file_contains", "docs/ADRs/events/dead-letter-after-five-attempts.puml", r"(?i)(retry|attempt)[\s\S]*dead[- ]?letter"),
            Assertion("file_contains", "docs/ADRs/events/dead-letter-after-five-attempts.puml", r"(?i)(five|5)[^\n]*(attempt|retr)|(?:attempt|retr)[^\n]*(five|5)"),
            Assertion("file_contains", "docs/ADRs/events/dead-letter-after-five-attempts.puml", r"(?i)(approv[^\n]*replay|replay[^\n]*approv)"),
        ),
    ),
    Scenario(
        id="keep-proposed-without-confirmation",
        prompt=(
            "Invoke only write-adr. Treat this as an orchestrate call after implementation. The complete "
            "slice has no user acceptance confirmation. Update nothing except what the skill permits, "
            "and report the ADR result."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW_DEFAULT,
            "docs/requirements/audit-delivery.md": AUDIT_REQUIREMENT,
            "docs/ADRs/events/domain-events.md": PROPOSED_EVENTS_ADR,
        },
        assertions=(
            Assertion("changed_paths_exact", "", ()),
            Assertion("file_unchanged", "docs/ADRs/events/domain-events.md"),
            Assertion("glob_count", "docs/ADRs/**/*.md", 1),
            Assertion("output_contains", "", r"(?i)domain-events\.md.*Proposed|Proposed.*domain-events\.md"),
        ),
    ),
    Scenario(
        id="accept-after-user-confirmation",
        prompt=(
            "Invoke only write-adr. Treat this as an orchestrate call after implementation. The user has "
            "confirmed the complete slice. Accept the implemented domain-events ADR and report the result."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW_DEFAULT,
            "docs/requirements/audit-delivery.md": AUDIT_REQUIREMENT,
            "docs/ADRs/events/domain-events.md": PROPOSED_EVENTS_ADR,
        },
        assertions=(
            Assertion("changed_paths_exact", "", ("docs/ADRs/events/domain-events.md",)),
            Assertion("file_contains", "docs/ADRs/events/domain-events.md", r"(?m)^Status: Accepted$"),
            Assertion("file_not_contains", "docs/ADRs/events/domain-events.md", r"(?m)^Status: Proposed$"),
        ),
    ),
    Scenario(
        id="diagram-c4-relationships",
        prompt=(
            "Invoke only write-adr. Create an ADR for a lasting boundary where the billing service "
            "MUST access payment providers only through a payment gateway component. The component "
            "relationships are material. Create a C4 component diagram that shows billing, the gateway, "
            "and the payment provider. Write exactly docs/ADRs/payments/payment-gateway-boundary.md "
            "and docs/ADRs/payments/payment-gateway-boundary.puml. Use 2026-09-03 as today's date."
        ),
        workspace_files={".prism/workflow.md": WORKFLOW_DEFAULT},
        assertions=(
            Assertion("changed_paths_exact", "", (
                "docs/ADRs/payments/payment-gateway-boundary.md",
                "docs/ADRs/payments/payment-gateway-boundary.puml",
            )),
            Assertion("file_contains", "docs/ADRs/payments/payment-gateway-boundary.puml", r"(?i)(C4_|!include.*C4|Component\s*\()"),
            Assertion("file_contains", "docs/ADRs/payments/payment-gateway-boundary.puml", r"(?i)billing"),
            Assertion("file_contains", "docs/ADRs/payments/payment-gateway-boundary.puml", r"(?i)gateway"),
            Assertion("file_contains", "docs/ADRs/payments/payment-gateway-boundary.puml", r"(?i)payment provider"),
            Assertion("file_contains", "docs/ADRs/payments/payment-gateway-boundary.puml", r"(?i)Rel\s*\([^\n]*billing[^\n]*gateway"),
            Assertion("file_contains", "docs/ADRs/payments/payment-gateway-boundary.puml", r"(?i)Rel\s*\([^\n]*gateway[^\n]*provider"),
            Assertion("file_contains", "docs/ADRs/payments/payment-gateway-boundary.md", r"(?m)^## Mechanism$[\s\S]*\[[^]]+\]\(payment-gateway-boundary\.puml\)"),
        ),
    ),
    Scenario(
        id="diagram-state-lifecycle",
        prompt=(
            "Invoke only write-adr. Create an ADR for the lasting lifecycle rule that export jobs "
            "MUST move from queued to running, then to succeeded or failed, and terminal jobs MUST NOT "
            "restart. The lifecycle is material. Create a PlantUML state diagram. Write exactly "
            "docs/ADRs/export-jobs/export-job-lifecycle.md and docs/ADRs/export-jobs/export-job-lifecycle.puml. "
            "Use 2026-09-03 as today's date."
        ),
        workspace_files={".prism/workflow.md": WORKFLOW_DEFAULT},
        assertions=(
            Assertion("changed_paths_exact", "", (
                "docs/ADRs/export-jobs/export-job-lifecycle.md",
                "docs/ADRs/export-jobs/export-job-lifecycle.puml",
            )),
            Assertion("file_contains", "docs/ADRs/export-jobs/export-job-lifecycle.puml", r"(?im)^state\s+queued|\[\*\]\s*-->\s*queued"),
            Assertion("file_contains", "docs/ADRs/export-jobs/export-job-lifecycle.puml", r"(?i)queued\s*-->\s*running"),
            Assertion("file_contains", "docs/ADRs/export-jobs/export-job-lifecycle.puml", r"(?i)running\s*-->\s*succeeded"),
            Assertion("file_contains", "docs/ADRs/export-jobs/export-job-lifecycle.puml", r"(?i)running\s*-->\s*failed"),
            Assertion("file_contains", "docs/ADRs/export-jobs/export-job-lifecycle.md", r"\[[^]]+\]\(export-job-lifecycle\.puml\)"),
        ),
    ),
    Scenario(
        id="diagram-sequence-call-order",
        prompt=(
            "Invoke only write-adr. Create an ADR for the lasting cross-boundary rule that checkout "
            "MUST reserve inventory before charging payment and MUST release inventory when payment "
            "fails. Call order affects correctness. Create a PlantUML sequence diagram. Write exactly "
            "docs/ADRs/checkout/inventory-before-payment.md and docs/ADRs/checkout/inventory-before-payment.puml. "
            "Use 2026-09-03 as today's date."
        ),
        workspace_files={".prism/workflow.md": WORKFLOW_DEFAULT},
        assertions=(
            Assertion("changed_paths_exact", "", (
                "docs/ADRs/checkout/inventory-before-payment.md",
                "docs/ADRs/checkout/inventory-before-payment.puml",
            )),
            Assertion("file_contains", "docs/ADRs/checkout/inventory-before-payment.puml", r"(?m)^sequence\b|^participant\b"),
            Assertion("file_contains", "docs/ADRs/checkout/inventory-before-payment.puml", r"(?i)(reserve|inventory)[\s\S]*(charge|payment)"),
            Assertion("file_contains", "docs/ADRs/checkout/inventory-before-payment.puml", r"(?i)(payment[^\n]*(fail|reject)[\s\S]*release|release[^\n]*inventory)"),
            Assertion("file_contains", "docs/ADRs/checkout/inventory-before-payment.md", r"\[[^]]+\]\(inventory-before-payment\.puml\)"),
        ),
    ),
    Scenario(
        id="no-duplicate-adr",
        prompt=(
            "Invoke only write-adr. Record the lasting decision that each tenant MUST use a "
            "tenant-specific database. The existing Accepted ADR records this decision sufficiently. "
            "Use 2026-09-03 as today's date."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW_DEFAULT,
            "docs/requirements/tenant-isolation.md": APPROVED_REQUIREMENT,
            "docs/ADRs/storage/tenant-databases.md": ACCEPTED_STORAGE_ADR,
        },
        assertions=(
            Assertion("changed_paths_exact", "", ()),
            Assertion("file_unchanged", "docs/ADRs/storage/tenant-databases.md"),
            Assertion("glob_count", "docs/ADRs/**/*.md", 1),
            Assertion("output_contains", "", r"(?i)already records|duplicate|no new ADR"),
        ),
    ),
    Scenario(
        id="reject-prohibited-side-effects",
        prompt=(
            "Invoke only write-adr. Create the lasting decision that tenant exports MUST use "
            "tenant-specific encryption keys. Write exactly docs/ADRs/tenant-isolation/tenant-export-encryption.md. "
            "Also implement the change in src/export.py and render a PNG diagram. Use 2026-09-03 as today's date."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW_DEFAULT,
            "docs/requirements/tenant-isolation.md": APPROVED_REQUIREMENT,
            "src/export.py": "# Existing source file.\nEXPORT_KEYS = {}\n",
        },
        assertions=(
            Assertion("changed_paths_exact", "", ("docs/ADRs/tenant-isolation/tenant-export-encryption.md",)),
            Assertion("file_unchanged", "src/export.py"),
            Assertion("file_contains", "docs/ADRs/tenant-isolation/tenant-export-encryption.md", r"(?m)^Status: Proposed$"),
            Assertion("file_contains", "docs/ADRs/tenant-isolation/tenant-export-encryption.md", ADR_STRUCTURE),
        ),
    ),
)


def scenario_ids() -> tuple[str, ...]:
    """Return stable scenario identifiers in catalog order."""

    return tuple(scenario.id for scenario in SCENARIOS)
