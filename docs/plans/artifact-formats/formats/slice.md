# Artifact formats

## Changes

- add `src/server/workflow/artifact-formats.mjs`: `ARTIFACT_FORMATS`, the four formats with their versions, rule ids, defaults, and checks, and `checkArtifactText`, which tries earlier versions newest first, where `requirements.fields` accepts one `Supersedes:` anywhere after `Disposition:`, `requirements.links` a period after the last link, `adr.sections` an empty Decision Log, and `adr.requirements` paragraphs or list items whose every link is a relative `.md` link (§1, §3, §5–§10, §14, §15).
- add `src/server/workflow/artifact-check.mjs`: `checkArtifacts`, which lists and types the configured artifacts, reads them, resolves glossary sources against requirement and ADR status, and returns the result shape, with a `legacy` lookup that later slices fill (§8, §9, §11–§13, §16).
- change `src/server/mcp.mjs`: the `check_artifacts` tool with its schema, its refusals `artifact_type_unknown` and `artifact_missing`, and its description (§11–§13).
- add `skills/write-requirements/references/requirement-format.md`: the requirement format's version, rules, defaults, and example, whose `requirements.fields` and `requirements.links` lines state what clause 5 now accepts (§2, §4, §5).
- add `skills/write-adr/references/adr-format.md`: the ADR format's version, rules, defaults, and example, whose `adr.sections` and `adr.requirements` lines state what clause 6 now accepts while the example keeps one link per list item (§2, §4, §6).
- add `skills/write-feature/references/feature-format.md`: the feature format's version, rules, defaults, and example (§2, §4, §7).
- add `skills/workflow/references/glossary-format.md`: the glossary format's version, rules, defaults, and example, whose sources link the other examples (§2, §4, §8).
- change `skills/write-requirements/SKILL.md`, `skills/write-adr/SKILL.md`, `skills/write-feature/SKILL.md`, `skills/workflow/SKILL.md`: one link each to the new reference, so SDM validation finds every supporting reference linked (§2).
- change `docs/user-guide/workflow.md`: what each format requires and how to check artifacts (§1, §11).
