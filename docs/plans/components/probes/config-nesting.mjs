// Show how today's workflow configuration parser reads nested entries under one section.
// Usage: node docs/plans/components/probes/config-nesting.mjs (from the repository root)
import { parseWorkflowConfig } from "../../../../dist/server/workflow/workflow-config.mjs";

const markdown = [
  "## Components",
  "- billing: packages/billing/",
  "  - Test command: npm test --workspace billing",
  "  - Depends on: shared",
  "- shared: packages/shared/",
  "  - Test command: bun test",
  "- Shared paths: bun.lock",
  ""
].join("\n");
console.log(JSON.stringify(parseWorkflowConfig(markdown).sections.Components));
