# Prepare one index per component

> Shipped history: initiative `components` shipped on 2026-11-07, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Outcome

Prism prepares, queues, and reports one index per component, keeps the others when one fails, and keeps a repository without components on its one index.

## Changes

- add `src/server/repository-intelligence/component-indexes.mts`: `indexComponents` reads the declaration for the native tools and refuses an invalid one, `componentSources` filters one project scan or retained baseline into one source per component with its content fingerprint, `selectComponents` picks the components a call's paths hold, `prepareComponents` queues and waits for the selected components and returns each one's state, and `componentResult` builds `components`, `status`, the `components_missing` diagnostic, `snapshot`, and `indexRevision` (§2, §3, §6, §8, §10, §11, §12, §13, §25)
- change `src/server/repository-intelligence/native-semantic-runtime.mts`: `NativeSemanticRuntime` keys `location`, `jobs`, and `generations` by component, `prepare` takes the component, a queue that the latest call reorders replaces `sequence`, a failure that reached a native limit is remembered per component content, and `status` reports each component (§4, §5, §7, §21)
- change `src/server/repository-intelligence/index-progress.mts`: `componentStorageKey` keys a component's storage by the project's real path and the component's name, while `projectStorageKey` stays the key of a repository without components (§1, §4)
- change `src/server/repository-intelligence/native-repository-intelligence.mjs`: `NativeRepositoryIntelligence` takes a file filter, so a component source scans, reads, and verifies only its own files (§2, §3)
- change `src/server/repository-intelligence/semantic-native-provider.mts`: `prepareNativeProvider` prepares the selected components in a repository that declares components and returns a provider over the included ones, and `searchRepositoryConcepts` returns the fields of clauses 10-13 and keeps today's path in a repository without components (§1, §8, §10, §11, §12, §13)
- change `src/server/repository-intelligence/repository-unit-types.mts`: `ComponentState` and the component fields of `Preparation` (§10, §21)
- change `src/server/mcp.mjs`: the descriptions of the native index and status tools say that a repository with components is indexed per component, which components a call reads, and what `partial` and `components_missing` mean (§8, §11, §12, §21)
- change `dist/server/repository-intelligence/component-indexes.mjs`, `dist/server/repository-intelligence/native-semantic-runtime.mjs`, `dist/server/repository-intelligence/index-progress.mjs`, `dist/server/repository-intelligence/native-repository-intelligence.mjs`, `dist/server/repository-intelligence/semantic-native-provider.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/repository-intelligence.md`: `Search for reusable concepts` explains the index per component, that documents outside every component stay in the root component's index, the limits per component, the build order, the `partial` status and `components_missing`, a component that reached a limit, and the status per component (§2, §5, §7, §11, §12, §21)
