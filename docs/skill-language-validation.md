# SDM validation behavior

Run `npm run validate:sdm` after each edit under `skills/`.
The validator rejects a skill that has no YAML frontmatter, no quoted `sdm` version, or an unsupported SDM version.
The validator warns when sibling headings mix numbered and unnumbered forms.
The validator warns when a `Do` or `Don't` marker has no nested list.
The validator warns when an action list item starts with `Do not`; use a declarative prohibition or a `Don't` block.
The validator ignores fenced code examples when it checks structure.
The validator does not prove that the skill follows every SDM writing rule.
Read [the Skill Definition Markdown standard](skill-language.md) before authoring or reviewing a skill.
Resolve every validator warning before you submit the change.
