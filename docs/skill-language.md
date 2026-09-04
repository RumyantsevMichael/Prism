---
sdm: "0.3"
---

# Skill Definition Markdown

Skill Definition Markdown (SDM) is a small set of Markdown conventions for writing skills that LLMs can follow.
SDM is a writing convention, not a programming language or execution format.
The `sdm` field identifies the SDM version.
A host reads the version before it interprets the document.
This specification is itself written in SDM.

## Prism version

Prism supports SDM `0.3`.
Put `sdm: "0.3"` in the frontmatter of each shipped Prism skill.
Read [SDM validation](skill-language-validation.md) for the repository checks.

## Core model

- Use plain Markdown and plain English
- Use declarative sentences for facts and required properties of a system, artifact, or result
- Use EARS (Easy Approach for Requirements Specification) patterns when a declarative statement needs a precise condition or response
- Use imperative list items for actions
- Use SDM only where procedure or grouping matters
- Treat a bare imperative as an instruction to the Agent
- Do not prefix a normal action with `Agent MUST`
- Use one term for one concept
- Use Markdown code formatting for exact paths, commands, identifiers, and values

## Headings

- Use headings to group related content
- SDM does not require particular headings or a fixed section structure
- Choose headings that fit the skill
- Treat each heading and its content as one group until the next heading at the same or higher level
- Read groups in source order unless sibling headings have numeric prefixes
- When sibling headings have numeric prefixes, use the prefixes as the group order
- Use numeric prefixes for all sibling headings when heading order matters
- Do not mix numbered and unnumbered sibling headings

## Declarative content

- Write declarative content in paragraphs or tables
- Use declarative content for facts, invariants, requirements, prohibitions, and result constraints
- Use EARS for precise declarative requirements as defined by [EARS](https://alistairmavin.com/ears/)
- Treat an EARS response as a required outcome, not as an instruction sequence
- Do not use EARS to describe the Agent's step-by-step procedure
- Treat ordinary explanatory prose as context, not as an action
- Do not hide an action in explanatory prose
- Treat fenced code blocks as examples or reference content, not as instructions
- Place an example near the instruction or declaration it illustrates
- Add a short comment inside a code block when the example needs explanation

## Imperative content

- Write actions as list items
- Start each unconditional action item with an imperative verb
- Write one action per item
- Apply ordered-list actions in source order
- Use an ordered list when action order matters
- Use an unordered list when actions are independent
- Use nested lists to group related actions
- Choose the nested list type according to whether child order matters
- Do not use list numbering only for visual styling
- Keep a condition or repetition with the actions it qualifies, either in the same item or in a nested list
- Express conditions and repetition in ordinary English
- Use `If`, `When`, `While`, and `For each` with their normal meanings
- Put a condition or repetition before its imperative action clause
- Do not add keywords when ordinary English is enough

## `Do` and `Don't` blocks

- Write `Do` as a list item with a nested list of positive guidance
- Write `Don't` as a list item with a nested list of prohibited guidance
- Use bullets when block entries are independent
- Use numbers when block entries have meaningful order
- Treat the labels as grouping markers, not as extra actions
- Keep conditions and repetitions in ordinary-English child items

## Terms and references

- Define a project-specific term before using it in an instruction
- Keep product glossary entries separate from skill glossary entries
- Link each project-specific term to its glossary entry
- Use normal Markdown links for glossary entries, examples, and references
- Use `file.md#heading-id` for an entry in another document
- Use `#heading-id` for an entry in the current document
- Use link text that names the target

## Minimal example

### 1. Prepare

The input file shall be valid Markdown.

1. Read `input.md`
2. Create `output.md`
3. If `input.md` exists, read its contents
4. For each section, copy its title

- Do
  - Preserve the input file
- Don't
  - Modify `input.md`

```text
Example output.
```
