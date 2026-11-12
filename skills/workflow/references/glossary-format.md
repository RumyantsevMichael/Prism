# Glossary format

Format version: 1
Example path: `docs/Glossary.md`

A glossary defines the project's terms, each with a stable identity, a definition whose first sentence stands on its own, and the decided sources that introduced it.
The `check_artifacts` tool reports each rule below that a glossary breaks, by its rule id.
A purpose, a definition, or a Source value may be the single word `unknown`, while the title and the term identities may not.

## Rules

- `glossary.text`: The file is UTF-8 text of at most 1 MiB.
- `glossary.title`: The first line is `# <name>`.
- `glossary.purpose`: One paragraph follows the title before the first term.
- `glossary.identity`: Each term is `## <term>` directly after `<a id="<id>"></a>`, where the id is lowercase letters and digits joined by single hyphens and no id repeats.
- `glossary.definition`: The first paragraph after the heading is the definition, and its first sentence ends with a period and starts with none of `It`, `This`, `That`, `These`, `They`, or `See`.
- `glossary.fields`: After the definition and any further paragraphs come one `Source:` line, an optional `Aliases:` line of comma-separated names, and optional `Not to be confused with: [<term>](#<id>): <distinction>` lines whose id is another term of the glossary, and nothing else.
- `glossary.source`: Source is comma-separated sources, each a Markdown link, resolved from the glossary's folder, to a requirement section `<path>.md#<n>` or an ADR file, or `migration <id>`, or in a migration's proposed content `migration` alone, which stands for that migration.
- `glossary.source-decided`: Each source resolves to a section of an Approved, Withdrawn, or Superseded requirement file, an Accepted or Superseded ADR, or an applied migration.
- `glossary.source-withdrawn`: At least one source is in force: an Active section of an Approved file, an Accepted ADR, or an applied migration.

## Defaults

- Default `Title`: `Glossary`

## Example

The example's sources link the examples of the [requirement format](../../write-requirements/references/requirement-format.md) and the [ADR format](../../write-adr/references/adr-format.md) at their example paths.

```markdown
# Glossary

Terms used across the upload service.

<a id="upload-token"></a>
## Upload token

The opaque identifier that the service issues for one upload and that a client presents to resume it.
A token stays valid until its upload completes or is discarded.

Source: [Identify an upload by a server-issued token](ADRs/uploads/upload-token.md)
Aliases: resume token
Not to be confused with: [Abandoned upload](#abandoned-upload): an abandoned upload is a state of the upload, while a token only names the upload.

<a id="abandoned-upload"></a>
## Abandoned upload

An interrupted upload that receives no part for one hour.

Source: [resumable-uploads.md§2](requirements/resumable-uploads.md#2)
```
