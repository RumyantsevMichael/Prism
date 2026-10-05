# Refactoring

Use `prism:refactor` when existing artifacts need a simpler conceptual structure.
The capability applies to code, skills, specifications, documentation, configuration, workflow definitions, policies, schemas, and other structured artifacts.

Example requests:

```text
Analyze the repository for overlapping retry policies and rank candidates for investigation.
Refactor the validation rules in this skill while preserving their conditions and authority.
Check whether existing configuration concepts can satisfy this requirement before adding another option.
```

Analysis requests return recommendations without editing target artifacts.
Transformation requests permit changes within the requested scope and preserve observable behavior by default.
A standalone invocation does not require an initiative or workflow setup.

Prism uses repository intelligence to find candidates, then checks their contracts, dependencies, state, ownership, and other available evidence.
Similarity identifies candidates.
It does not prove equivalence or justify a shared abstraction.
When semantic discovery is unavailable, the result identifies that limitation and uses available evidence.
Managed slices retain their existing semantic evidence and review requirements.

The result explains the investigated concepts, evidence, relationship, desired model, transformation, behavior impact, equivalence checks, complexity changes, uncertainty, and required decisions.
It can recommend keeping concepts distinct or making no change.
For text and declarations, Prism considers reconstructing the affected content from its current obligations.

Complexity evidence keeps dimensions separate.
Measurements use available deterministic tools, while unknown dimensions and qualitative judgments remain explicit.
A new abstraction can increase concept count while reducing duplicated knowledge and required caller knowledge.
No single count establishes improvement.

Design uses the same analysis to choose existing or new concepts for required behavior.
Implementation uses it within the accepted design, and review checks conceptual improvement and behavior preservation.
If an improvement requires a behavior, requirement, or architectural decision outside the invocation's authority, Prism returns that decision to the caller.
