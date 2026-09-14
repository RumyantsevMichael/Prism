# Worker lifetime

Use host progress events when available, and treat a worker wait timeout or missing completion event as non-terminal while preserving partial evidence.
Wait again or resume the same worker before replacement, and replace it only after explicit completion, failure, blocker, or confirmed host termination.
A phase result such as `FIT` or `FINDINGS` is a handoff, not a close condition, when another worker must communicate with that worker.
For a multi correction exchange, keep the `Develop <slice>` worker available after `FIT` and the `Review <slice>` worker available after `FINDINGS`, resume both as live workers before messaging, and close neither until the exchange and fresh-review handoff are complete.
