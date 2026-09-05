# Delegation

Inspect callable host actions before delegation.

Child-agent capability exists only when a child-start action is callable.
A wait or status action alone is not child-agent capability.
Use native child agents when the current context has a callable child-start action.
Do not use a host action that creates a user-owned task, thread, or chat to imitate a child agent.
Before starting a child, confirm that the child inherits the active parent permission and sandbox settings.
Otherwise, return a broker request to the nearest parent with child-agent capability.
Pass the model role and resolved model through every child start and broker request.

Use this exact broker request:

```text
Kind: explore | task | review
Scope: <slice, investigation, or review lane>
Inputs: <artifact and code paths>
Output: <scratch report path or workspace>
Profile: <execution profile>
Model role: <role>
Model: <resolved model or host default>
```

Put large read-only findings in the supplied scratch path.
Use the owning initiative coordination directory for scratch output when it exists.
Otherwise, use task-scoped temporary scratch and delete it after the phase.
Return only paths and short status records through the broker.

When no parent can delegate, use the project fallback or work inline when permitted.
When no native child-agent capability exists, do not create a visible task as a fallback.
When no context can provide a fresh reviewer, ask the user to run `review` in a separate task.

Render an execution profile as:

- Complexity: standard | high
- Context: fresh | resume
- Parallelism: sequential | independent
- Focus: <specific risks>
- Model role: delivery | review | security-review
- Model: <resolved model or host default>
