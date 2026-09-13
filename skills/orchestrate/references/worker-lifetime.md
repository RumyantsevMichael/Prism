# Worker lifetime

Use host progress events when available, and treat a worker wait timeout or missing completion event as non-terminal while preserving partial evidence.
Wait again or resume the same worker before replacement, and replace it only after explicit completion, failure, blocker, or confirmed host termination.
