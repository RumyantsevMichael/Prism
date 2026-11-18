---
name: write-diagram
description: "Write one PlantUML diagram view of a contract, of one kind such as sequence, activity, state, component, data model, deployment, or code, that answers a question the person at the design gate will ask. Use when design has chosen a diagram view for a contract or slice."
argument-hint: '[kind] [file]'
sdm: "0.3"
---

# Write a diagram view

A [view](../workflow/SKILL.md#common-terms) explains contract clauses to the person at the design gate, and the contract decides where the two differ.
Each view answers one question that its declaration states, so draw only what that question needs.

## 1. Choose the kind

Read only the reference of the kind you write.

| Kind | Answers a question such as | Reference |
| --- | --- | --- |
| `sequence` | Who calls whom, in what order, and what comes back on each path? | [sequence.md](references/sequence.md) |
| `activity` | Which steps and decisions does one operation take? | [activity.md](references/activity.md) |
| `state` | Which states does a record move through, and what moves it? | [state.md](references/state.md) |
| `component` | Which parts exist, and which interfaces connect them? | [component.md](references/component.md) |
| `data-model` | Which records exist, and how many of one belong to another? | [data-model.md](references/data-model.md) |
| `deployment` | Where does each part run, and what crosses between machines? | [deployment.md](references/deployment.md) |
| `code` | Which units change, and how do they depend on each other? | [code.md](references/code.md) |

A screen is a `wireframe` view, written with `write-mockup`, and an API specification is an `api` view, written with `write-contracts`.

## 2. Declare the view

Put the file directly in the folder of the `slice.md` whose contract it explains, and declare it in that file's **Views** section, one item per view:

```markdown
## Views
- `download.puml` sequence (§1, §2): What does the CLI ask storage, and what does the user see for a missing report?
```

- The parentheses cite the contract clauses the view explains.
- The question ends with `?`.
- An undeclared `.puml` file in the folder is refused.

## 3. Write the source

1. Write PlantUML source only, starting with `@startuml`, following the kind's reference.
2. Keep the view within its kind's limits:

   | Kind | Elements | Limit | Relations | Limit |
   | --- | --- | --- | --- | --- |
   | `sequence` | participants | 10 | messages | 30 |
   | `activity` | actions and decisions | 30 | none | none |
   | `state` | states, without `[*]` | 20 | transitions | 40 |
   | `component`, `deployment`, `code`, `data-model` | elements | 30 | relations | 50 |

3. When a view is beyond a limit, split it into views that each answer a narrower question.
4. When a view in the folder of a slice is dense, beyond two thirds of a limit, split the slice, or keep it whole with a **Split assessment** item in that `slice.md`:

   ```markdown
   ## Split assessment
   - `download.puml`: the eight participants are one request path, and no part of it is observable alone.
   ```

5. When Prism reports a view problem, fix the source or its declaration.

- Don't
  - Render the view or look at a rendered image.
  - Draw a fact that no cited clause states.
