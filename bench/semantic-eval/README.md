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
| `repeatedShare` | The share of embedded tokens whose source a smaller concept also embeds. |
| `lineEndCutShare` | The share of cuts inside a concept that fall at a line end. |
| `smallFragments` | The number of fragments with fewer than 20 tokens. |

The retrieval metrics are hit@5, hit@10, and MRR for each query group.
`baseline30` is the original set of 30 queries, which contains the `concept` and `exact` groups.
Each run writes `summary-<label>.json` in the output directory.

## Queries

`queries/prism.json` labels queries for this repository.
A query passes when a result matches an expected file and name.
An expected entry with `within: true` also accepts any result inside the expected concept.
A `queryFrom` entry uses the source of one concept as the query and ignores that concept in the results.

| Group | Purpose |
| --- | --- |
| `concept` | Natural-language descriptions of code and documents. |
| `exact` | Identifiers and exact strings. |
| `sibling` | One method among the methods of one class. |
| `members` | A class name with a member behavior, or a class description. |
| `section` | One Markdown section among sibling sections. |
| `code-to-code` | Similar code in a different file. |

The benchmark never indexes its own folder, because the queries contain the expected answers.
Update the labels when a labeled concept moves or changes its name.
