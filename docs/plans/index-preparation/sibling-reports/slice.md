# Sibling components in scoped reports

## Outcome

A scoped cross-file report includes the members of its groups in sibling components.

## Changes

- change `src/server/repository-intelligence/native-semantic-runtime.mts`: `prepareComponents` takes a structure-only option per entry, whose job passes `fragmentsOnly: true`, stores a structure-only index, and ends `ready`, while a later full need of the same content builds it in full (§26)
- change `src/server/repository-intelligence/component-indexes.mts`: `selectedComponents` returns the sibling components beside the selected ones, and `prepareComponents` prepares siblings with structure only (§25, §26)
- change `src/server/repository-intelligence/semantic-native-provider.mts`: `componentAnalysis` reads siblings for `find_shared_dependencies`, `find_shared_literals`, `find_same_name_units`, and `report_module_interfaces`, keeps today's selection for `report_cohesion_clusters` and `report_complex_units`, and the `COMPONENT_REPORT` description and the paths descriptions say so (§25–§27)
- change `src/server/repository-intelligence/repository-unit-types.mts`: the structure-only option of `ComponentRuntime.prepareComponents` (§26)
- change `test/server/component-reports.test.mjs`: its clause 9 test expects a scoped same-name and module report to read sibling components (§25)
- change `dist/server/repository-intelligence/native-semantic-runtime.mjs`, `dist/server/repository-intelligence/component-indexes.mjs`, `dist/server/repository-intelligence/semantic-native-provider.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/repository-intelligence.md`: `Report and plan across component indexes` explains that a scoped cross-file report reads sibling components with structure only (§25–§27)
