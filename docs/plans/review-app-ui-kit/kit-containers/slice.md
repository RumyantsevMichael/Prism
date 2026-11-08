# Kit containers, claims, and content blocks

## Changes
- add `src/server/review/public/kit/elements/prism-panel.js`: heading, tools, footer, maximize, and the island variant (clause 41).
- add `src/server/review/public/kit/elements/prism-tree.js`, `src/server/review/public/kit/elements/prism-tree-item.js`: tree with roving focus, expansion, and selection (clauses 42, 43).
- add `src/server/review/public/kit/elements/prism-listbox.js`, `src/server/review/public/kit/elements/prism-list-item.js`: listbox driven from a field or by its own focus, with each option's kind (clause 44).
- add `src/server/review/public/kit/elements/prism-dialog.js`: glass modal dialog over a native dialog, a blurred scrim, the start and bottom placements, and focus return (clauses 45, 56).
- add `src/server/review/public/kit/elements/prism-popover.js`: glass non-modal popover anchored to its button, full width on narrow windows (clauses 46, 56).
- add `src/server/review/public/kit/elements/prism-disclosure.js`, `src/server/review/public/kit/elements/prism-empty-state.js`, `src/server/review/public/kit/elements/prism-banner.js`, `src/server/review/public/kit/elements/prism-toast.js`: disclosure, empty state, banner, and glass toast region (clauses 47, 48, 49, 56).
- add `src/server/review/public/kit/elements/prism-stat.js`, `src/server/review/public/kit/elements/prism-stat.css`, `src/server/review/public/kit/elements/prism-meter.js`, `src/server/review/public/kit/elements/prism-meter.css`, `src/server/review/public/kit/elements/prism-spinner.js`, `src/server/review/public/kit/elements/prism-spinner.css`: stat tile, progress meter, and spinner (clause 50).
- add `src/server/review/public/kit/elements/prism-doc.js`, `src/server/review/public/kit/elements/prism-code.js`: Markdown and code containers with line numbers and a syntax fallback (clause 51).
- add `src/server/review/public/kit/elements/prism-avatar.js`, `src/server/review/public/kit/elements/prism-avatar.css`: agent and person avatars with the live dot, breathing, and the expired outline (clause 52).
- add `src/server/review/public/kit/elements/prism-claim.js`, `src/server/review/public/kit/claim-time.js`: the read-only claim in its avatar, inline, and strip forms, with the time left in words updated each minute and the lease meter (clause 53).
- add `src/server/review/public/kit/elements/prism-stepper.js`, `src/server/review/public/kit/elements/prism-step.js`: the lifecycle stepper with phase bars and written states (clause 54).
- add `src/server/review/public/kit/elements/prism-breadcrumbs.js`: the breadcrumb navigation with shortened crumbs (clause 55).
- change `src/server/review/public/kit/kit.js`, `src/server/review/public/kit/kit.css`: registers and styles the containers, claims, and content blocks, and the shared glass surface (clauses 27, 28, 38, 56).
- change `src/server/review/public/kit/catalog.js`: specimens with many items for trees, listboxes, panels, steppers, and breadcrumbs, and an expired claim (clause 57).
- change `dist/server/review/public/kit`: regenerated output.
