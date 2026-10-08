# Semantic retrieval benchmark

This benchmark measures native semantic chunking and retrieval on a real repository.
It drives the generated worker in `dist/native-runtime` directly, without the MCP server.

## Run

Build the runtime first.

```bash
npm run build:native
```

Measure the fragments only.
This run skips embedding and takes a few seconds.

```bash
node bench/semantic-eval/run.mjs --fragments-only
```

Measure retrieval with the labeled queries.

```bash
node bench/semantic-eval/run.mjs --label after --show 3
```

The first full run embeds every fragment and takes several minutes.
Later runs reuse the vectors in `.work/embeddings.json` and embed only changed fragment text.
To query a saved index again without a build, add `--reuse-index`.

The benchmark finds the model in the plugin data directory.
To use another model directory, pass `--model` or set `PRISM_MODEL_DIRECTORY`.
To measure another worker build, pass `--worker`.

## Output

The fragment statistics are:

| Field | Meaning |
| --- | --- |
| `fragments` and `roles` | The number of fragments for each role. |
| `embeddedTokens` | The tokens that the model embeds, including special tokens. |
| `repeatedShare` | The share of embedded tokens whose source a smaller unit also embeds. |
| `lineEndCutShare` | The share of cuts inside a unit that fall at a line end. |
| `smallFragments` | The number of fragments with fewer than 20 tokens. |

The retrieval metrics are hit@5, hit@10, MRR, and recall@10 for each query group.
MRR uses the first correct result only.
Recall@10 is the share of labeled answers in the top 10, which matters when a query has many correct answers.
`baseline30` is the original set of 30 queries, which contains the `description` and `exact` groups.
Each run writes `summary-<label>.json` in the output directory.

## Queries

`queries/prism.json` labels queries for this repository.
A result is correct when it matches one expected entry.

| Entry | Match |
| --- | --- |
| `{ "file", "name" }` | A unit with this name or qualified name in the file. |
| `{ "file", "name", "kind" }` | The same, limited to one unit kind, when two units share a name. |
| `{ "file", "name", "within": true }` | Any result inside the named unit, usually a Markdown section. |
| `{ "file", "contains" }` | A result whose source lines contain the text. Markdown markup characters do not count. |
| `{ "file" }` | Any result in the file. Use this only for a document or a small file that is entirely about the query. |

Use `contains` with one complete sentence for a paragraph or a list item, because their stored names are cut at 160 characters.
A `queryFrom` entry uses the source of one unit as the query and ignores that unit in the results.
The source of a `queryFrom` unit must fit in the 512-token query limit of the model.

| Group | Purpose |
| --- | --- |
| `description` | Natural-language descriptions of code and documents. |
| `exact` | Identifiers and exact strings. |
| `sibling` | One method among the methods of one class. |
| `members` | A class name with a member behavior, or a class description. |
| `section` | One Markdown section among sibling sections. |
| `code-to-code` | Similar code in a different file. |

The benchmark never indexes its own folder, because the queries contain the expected answers.
Update the labels when a labeled unit moves or changes its name.

## Relevance rules

A result is relevant when its unit implements, specifies, or documents the exact behavior that the query describes.
Requirements, ADRs, user guides, skills, and plans that state the behavior are relevant, not only code.
A unit that only shares words, only calls the behavior, or describes a broader topic is not relevant.

| Group | Additional rule |
| --- | --- |
| `sibling` | Another method of the same class is relevant only when it performs the same behavior. |
| `members` | A class-description query expects the class itself, not only its members. |
| `section` | Other sections that give the same instructions are also relevant. |
| `code-to-code` | Other implementations of the same behavior are relevant. |
| `exact` | A unit must define, produce, or be about the exact string, not only mention it. |

Label every relevant answer, not only the first one that you expect.
To add labels, pool the top 10 results of every compared system for each query and judge the pooled results.
Labels that come from only one system favor that system.
