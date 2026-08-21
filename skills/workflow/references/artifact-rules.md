# Artifact rules

Read this reference when a phase creates or reviews diagrams, durable documentation, or user guidance.

Write PlantUML source beside the durable artifact or code area that it explains.
Read the source and do not read rendered images as implementation input.
Do not commit rendered images.

Create an ADR decision diagram during design when relationships, lifecycle, or call order are part of the decision.
Create or update an implemented-structure diagram after code establishes the structure.
Derive implemented structural relationships from code or CodeGraph when available.
Add only information that materially improves human understanding.
Do not use a diagram to instruct another agent how to implement the slice.
Use a dependency graph for roadmap initiatives and initiative slices.
Use a C4, component, class, state, or sequence diagram only when it materially improves understanding.
Do not add diagrams to requirements or feature files.

Durable artifacts must not reference slice names, plan sections, scratch paths, or temporary status identifiers.
Cite a requirement for an obligation.
Cite an ADR for rationale.
Describe the implemented behavior directly.

Update the configured user-guide path when observable behavior changes.
Ship an operator runbook with an operational capability.
Use exact verified commands or UI steps.
Mark an unsettled operational decision as `TBD`.
