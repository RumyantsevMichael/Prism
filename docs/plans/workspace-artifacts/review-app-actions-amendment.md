# Proposed amendment of review app actions §15

Status: Pending the person's answer
Created: 2026-11-09

This is a proposed diff of the Approved [review-app-actions.md](../../requirements/review-app-actions.md), which stays unchanged until the person accepts it.
The person accepted on 2026-11-09 that an approval of a requirement or ADR keeps its history in that document's status record, which [§15](../../requirements/review-app-actions.md#15) now states in place of §7.
This diff covers the part that was not yet put to the person: a comment on any store artifact, which belongs to no initiative, keeps its history in the comment's own record.
§8 stays as it is: the attention feed of every connected tab shows an approval and a comment as it shows every other applied action, reading each entry from where it is kept.
On acceptance, the replacement §16, the disposition change of §15, and a reciprocal `[§16](#16)` link in the Related lines of §8, §9, and §13 are applied to the file together, and this file is removed.

```diff
 <a id="15"></a>
 ## 15. Record each applied action where its target belongs
 
 Pattern: Event-driven
 
-Disposition: Active
+Disposition: Superseded by [§16](#16)
 
 Supersedes: [§7](#7)
@@
+<a id="16"></a>
+## 16. Record each applied action, comments included, where its target belongs
+
+Pattern: Event-driven
+
+Disposition: Active
+
+Supersedes: [§15](#15)
+
+Requirement: When Prism applies an action, Prism shall record the action, its target, the time, that it came from the review app, and the value before and after in the history of the target's initiative, in the history of the checkout whose index it rebuilds when the target is an index, in the status record of the approved requirement or ADR when the target is its approval gate, or in the comment's own record when the action comments on an artifact.
+
+Rationale: Agents and people can then see who changed what, and when, after the page closes, and an approval, which is asked before any initiative exists, and a comment, which any artifact can take, keep their history with the artifact they concern.
+
+Related: [§8](#8), [§9](#9), [workspace-artifacts.md§9](workspace-artifacts.md#9), [workspace-artifacts.md§11](workspace-artifacts.md#11)
```
