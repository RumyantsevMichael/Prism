# Local workflow decision history

Prism can record structured workflow decisions for one project in its local plugin data directory.
Recording starts disabled for each project.

Use `set_workflow_recording` with the project root, Prism plugin data directory, and `enabled: true` to start recording.
Use the same tool with `enabled: false` to stop new records.
Use `read_workflow_decisions` to inspect ordered records and coverage gaps.
Pass `statePath` and relevant `recoveryPaths` to classify recovery notes for active and inactive slices.

The history stores provider choices, estimate reasons, diagram judgments, review outcomes, and pause checkpoints.
It stores approximate verified-source tokens separately from fit-eligible estimate bounds.
It does not store prompts, source text, command text, tool output, or transcripts.
Prism hides records older than 30 days and removes aged files on later writes.
Prism limits the event directory to 64 MiB.

A verified host session digest identifies an execution when current host facts match the project and correlation key.
An agent label is a claim from the caller and does not prove host identity.
Coverage gaps show when Prism cannot verify an execution or observe a subagent checkpoint.
An inactive parent recovery note is historical even when its content is old.
