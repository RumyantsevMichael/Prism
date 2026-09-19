# Repository context planning

A context plan estimates the repository source that an implementation worker must read before and during one slice.
It does not estimate generic task complexity or generated code size.

## Plan the context

1. Use the repository-context planning capability when it is available.
2. Pass the slice outcome, explicit files, explicit symbols, domain concepts, and expected modification targets as hints.
3. Use automatic provider selection unless the user or repository policy requires `native`, `codegraph`, or `codenib` explicitly.
4. Use `list_repository_intelligence_providers` before an explicit external selection when its availability is unknown.
5. Confirm that the plan commit matches the source used for design.
6. Inspect every `mustRead`, `likelyRead`, and `possibleRead` reason before the fit decision.
7. Inspect provider contributors, capabilities, fallback, and diagnostics before using the estimate.
8. Treat unresolved concepts, stale source, missing semantic retrieval, and incomplete graph coverage as uncertainty evidence.

The native provider is always the live-source baseline.
An external provider is optional and can add semantic or structural evidence.
A native-only or CodeGraph plan cannot claim semantic coverage and therefore cannot support a numeric `FIT` result.

## Calculate the repository read budget

Use `evaluate_repository_fit` when the repository-intelligence capability exposes it.
Use `session.mode: active` when same-session hook facts are enabled and the target is the current session.
Otherwise, identify the target implementation session by its host, host version, provider, and model.
Pass explicit capacity overrides when the target session changes registered defaults.
Treat an `UNSUPPORTED` capacity result as unavailable budget evidence.
Inspect the stable reason code before requesting missing facts or using explicit input.
Do not substitute the advertised model context limit for the resolved compaction threshold.

```text
repositoryReadBudget =
  compactionThreshold
  - baseSessionContext
  - featureDesignContext
  - implementationReserve
```

`baseSessionContext` is the context already present in the target session before its assigned design artifacts.
For a fresh worker, it includes the worker's startup context.
For a resumed worker, it includes the context retained at the fit checkpoint.
`featureDesignContext` includes only assigned design content not already counted in the base value.
`implementationReserve` uses the registered policy unless the caller supplies a nonnegative override.

Apply this policy when capacity resolution is `SUPPORTED` and every target-session cost is known.
When a selected source range is incomplete and an estimate is `null`, classify the result as `UNCERTAIN`.
When retrieval returns no anchors and estimates are `null`, classify the result as `UNCERTAIN`.

```text
if upper <= repositoryReadBudget:
    FIT
else if lower > repositoryReadBudget:
    SPLIT
else:
    UNCERTAIN
```

`UNCERTAIN` requires more evidence or a safer split before a `FIT` result.
When budget inputs are unavailable, keep the context plan separate and use the existing fit evidence without inventing a numeric budget.
Inspect the returned capacity and reserve provenance before accepting the decision.

## Interpret token estimates

The lower estimate counts merged `mustRead` ranges.
The expected estimate counts merged `mustRead` and `likelyRead` ranges.
The upper estimate counts all merged ranges.
The plan identifies whether its counter uses an exact target-model tokenizer or a documented estimator.
An incomplete selected source range makes its estimate and every wider estimate `null`.
Do not use file count, changed-file count, raw bytes, or unmerged source ranges as a substitute.
