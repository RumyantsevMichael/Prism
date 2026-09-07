---
name: write-feature
description: "Create or update a Gherkin acceptance feature file from approved observable behavior."
sdm: "0.3"
---

# Write a Gherkin acceptance feature

A [feature file](../workflow/SKILL.md#common-terms) specifies observable behavior in domain language.
Design authors it after atomic fit, including when corrections return from implementation or review.

## 1. Prepare

1. If `.prism/workflow.md` exists, read it first.
2. Read Approved requirements, governing ADRs, the glossary, and related features.
3. Inspect the selected code and tests for compatibility and acceptance paths.
4. If intended behavior conflicts with the design or durable sources, stop and report the conflict.

Requirements govern behavior, while ADRs constrain architecture.
Existing code and tests do not authorize new behavior.

## 2. Write the feature

1. Create or update `F-<capability>.feature` in the configured feature directory, defaulting to `docs/Features/`.
2. Use this shape for each invariant:

   ```gherkin
   Feature: <observable capability>

     Rule: <one behavioral invariant>
       # Requirement: [requirement title](../requirements/example.md#anchor)

       Example: <observable result>
         Given <world state>
         When <one action or event>
         Then <observable outcome>
   ```

3. Link each Rule to its Approved requirements and any ADR that constrains its behavior.
4. Select the fewest examples covering normal behavior and meaningful failure or boundary cases.
5. Name examples by their observable result.
6. Use one When per example and separate Then steps for separate claims.
7. Use Background only for setup required by every example.
8. When capability boundaries permit, split files that reach 150 lines.

Features contain no internal code names, field paths, module paths, or implementation instructions.
This skill creates neither step definitions nor BDD dependencies.
Specification-only features remain specifications, while configured BDD features bind through `write-step-definitions` during implementation.

## 3. Return the specification

1. Check requirement coverage, observable assertions, and domain language.
2. Return feature paths and each example's selected test path or command.

Completed code and passing tests are not required for this result.
