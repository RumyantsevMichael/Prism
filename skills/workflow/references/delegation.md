# Delegation

Child-agent capability exists only when a child-start action is callable, and a wait or status action alone is not that capability.
A host action that creates a user-owned task, thread, or chat is not a child agent.

- Start each child with the inputs it needs as files and identifiers, not a summary of the parent conversation.
- Confirm that the child inherits the parent's permission and sandbox settings.
- Pass the model that the run settings select for the child's role.
- When no child agent can start, work inline when the flow permits it, and otherwise ask the user to run the skill in a separate task.
- Put large read-only findings in a scratch path only when a later child needs them, and delete task-scoped scratch after the phase.
