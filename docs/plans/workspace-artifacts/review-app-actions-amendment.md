# Proposed amendment of review app actions §7

Status: Pending the person's answer
Created: 2026-11-09

This is a proposed diff of the Approved [review-app-actions.md](../../requirements/review-app-actions.md), which stays unchanged until the person accepts it.
It lets an approval of a requirement or ADR and a comment on any store artifact, which belong to no initiative, be actions whose history is kept with the artifact: the approved artifact's status record and the comment's own file.
On acceptance, the replacement §15, the disposition change of §7, and a reciprocal `[§15](#15)` link in the Related lines of §8, §9, and §13 are applied to the file together, and this file is removed.

```diff
 <a id="7"></a>
 ## 7. Record each applied action
 
 Pattern: Event-driven
 
-Disposition: Active
+Disposition: Superseded by [§15](#15)
 
 Requirement: When Prism applies an action, Prism shall record in the history of the target's initiative, or of the checkout whose index it rebuilds when the target is an index, the action, its target, the time, that it came from the review app, and the value before and after.
@@
+<a id="15"></a>
+## 15. Record each applied action where its target belongs
+
+Pattern: Event-driven
+
+Disposition: Active
+
+Supersedes: [§7](#7)
+
+Requirement: When Prism applies an action, Prism shall record the action, its target, the time, that it came from the review app, and the value before and after in the history of the target's initiative, in the history of the checkout whose index it rebuilds when the target is an index, in the status record of the approved requirement or ADR when the target is its approval gate, or in the comment's own record when the action comments on an artifact.
+
+Rationale: Agents and people can then see who changed what, and when, after the page closes, and an approval, which is asked before any initiative exists, and a comment, which any artifact can take, keep their history with the artifact they concern.
+
+Related: [§8](#8), [§9](#9), [workspace-artifacts.md§11](workspace-artifacts.md#11)
```
