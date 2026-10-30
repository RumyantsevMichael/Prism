// Build an edge-case project for layout checks: unbroken long names, long text, many records, deep slice trees, and unreadable records.
// Usage: node scripts/review-demo/seed-stress.mjs [project-directory]
import { prepareProject, startTools } from "./project.mjs";

const { realRoot, dataDir, write } = await prepareProject(process.argv[2], "prism-review-stress-");
const LONG = "Supercalifragilisticexpialidocious-unbroken-identifier-that-never-wraps-anywhere-at-all-0123456789";
const PARA = "This sentence is deliberately long so that the layout has to wrap it across many lines, and it keeps going with more clauses, more qualifications, and more detail than any reasonable summary would ever carry. ";
const base = "docs/plans/huge-initiative";
const slicePath = `${base}/slice-with-long-name`;
const key = { initiative: "huge-initiative", slice: "slice-with-long-name" };
const deltaPath = ".prism/initiatives/huge-initiative/slices/slice-with-long-name/change-map.json";
const reviewPath = ".prism/initiatives/huge-initiative/slices/slice-with-long-name/review.json";
const notesPath = `${slicePath}/notes-${LONG.toLowerCase()}.md`;
const requirementFiles = Array.from({ length: 14 }, (_, i) => `docs/requirements/${i === 0 ? `a-requirement-file-with-an-extremely-long-name-${LONG.toLowerCase()}` : `area-${i}`}.md`);

await write(".prism/workflow.md", "# Workflow config\n\n## Paths\n- Requirements: docs/requirements/\n- ADRs: docs/ADRs/\n- Plans (scratch): docs/plans/\n- Roadmap: docs/roadmap.md\n- Glossary: docs/Glossary.md\n");
for (const [i, file] of requirementFiles.entries()) {
  await write(file, `# ${i === 0 ? LONG : `Requirement area number ${i} with a fairly long descriptive title`}\n\nStatus: ${i % 3 ? "Approved" : "Draft"}\nCreated: 2026-09-0${(i % 9) + 1}\n${i % 3 ? "Approved: 2026-09-10\n" : ""}\n<a id="1"></a>\n## 1. First requirement\n\n${PARA.repeat(3)}\n\n<a id="2"></a>\n## 2. ${LONG}\n\nWhen \`${LONG}\` happens, the system shall respond.\n`);
}
for (let i = 0; i < 12; i += 1) {
  await write(`docs/ADRs/topic-${i % 4}${i % 4 === 3 ? `-${LONG.toLowerCase()}` : ""}/decision-${i}.md`, `# Decision ${i}: ${i === 2 ? LONG : "choose a reasonably long and descriptive decision title"}\n\nStatus: ${["Proposed", "Accepted", "Superseded", "Deprecated"][i % 4]}\nCreated: 2026-08-1${i % 10}\n\n## Decision\n\n${PARA.repeat(2)}\n`);
}
await write("docs/Glossary.md", `# Glossary\n\n${PARA}\n\n| Term | Definition |\n| --- | --- |\n${Array.from({ length: 30 }, (_, i) => `| ${i === 3 ? LONG : `Term ${i}`} | ${i % 5 === 0 ? PARA.repeat(2) : "A short definition."} |`).join("\n")}\n`);
await write("docs/wide.md", `# ${LONG} ${LONG}\n\n${PARA}\n\n| ${Array.from({ length: 12 }, (_, i) => `Column ${i}`).join(" | ")} |\n| ${Array.from({ length: 12 }, () => "---").join(" | ")} |\n| ${Array.from({ length: 12 }, (_, i) => (i === 4 ? LONG : `value ${i}`)).join(" | ")} |\n\n\`\`\`\n${"const x = 1; // a very long line of code that will not wrap ".repeat(6)}\n\`\`\`\n\nA bare link: https://example.com/${LONG}/${LONG}\n\nInline code \`${LONG}\` in a sentence.\n\n> A blockquote with ${LONG}.\n\n- Level 1\n  - Level 2\n    - Level 3\n      - Level 4 ${PARA}\n\n${Array.from({ length: 12 }, (_, i) => `## Heading ${i} ${i === 5 ? LONG : ""}\n\n${PARA}\n`).join("\n")}`);
for (let i = 0; i < 20; i += 1) {
  await write(`src/module-${i}/${i === 0 ? LONG : "file"}.ts`, `export class Unit${i} {}\n`);
}
// A split into parts cites an Unprobed assumption that one part settles, because the server refuses a split without evidence.
const ASSUMPTION = "the upstream service answers within the page budget";
const splitParents = { "huge-initiative": "docs/plans/huge-initiative", "slice-3": "docs/plans/huge-initiative/slice-3", "slice-8": "docs/plans/huge-initiative/slice-8", "slice-12": "docs/plans/huge-initiative/slice-12" };
for (const folder of Object.values(splitParents)) await write(`${folder}/slice.md`, `# ${LONG}\n\n## Assumptions\n- Unprobed: ${ASSUMPTION}; a slow answer shows an error.\n`);
const evidence = (settledBy) => ({ kind: "unfrozen", assumption: ASSUMPTION, settledBy });
await write(`${slicePath}/slice.md`, `# ${LONG}\n\n${PARA.repeat(4)}\n`);
await write(`${slicePath}/diagram.puml`, `@startuml\nclass ${LONG.replace(/-/g, "_")}\n${Array.from({ length: 13 }, (_, i) => `VeryLongClassNameNumber${i + 1}ForWideDiagrams --> VeryLongClassNameNumber${((i + 3) % 13) + 1}ForWideDiagrams`).join("\n")}\n@enduml\n`);
await write(notesPath, `# Notes\n\n${PARA}\n`);
await write(".prism/initiatives/broken/initiative.json", "{ this is not json");
await write(".prism/initiatives/broken/state.json", "{\"schemaVersion\": 1, \"slices\": ");

const { call, close } = startTools(realRoot, dataDir);
let reviewRevision = null;
async function review(actor, operations) {
  const result = await call("update_review", { projectRoot: realRoot, ...key, delivery: "delivery", expectedRevision: reviewRevision, actor, operations });
  reviewRevision = result.revision;
}

try {
  const baseline = await call("capture_repository_snapshot", { projectRoot: realRoot, ...key });
  const unit = (i) => [{ path: `src/module-${i}/${i === 0 ? LONG : "file"}.ts`, selector: `Unit${i}` }];
  const changes = Array.from({ length: 20 }, (_, i) => {
    const action = ["ADD", "MODIFY", "REPLACE", "DELETE", "KEEP"][i % 5];
    return { id: `change-${i}`, kind: ["class", "configuration-option", "document", "function"][i % 4], label: i === 0 ? LONG : `ChangedUnitNumber${i}WithLongName`, action, before: action === "ADD" ? [] : unit(i), after: action === "DELETE" ? [] : unit(i), reason: i % 3 ? PARA : "Short." };
  });
  const delta = await call("update_change_map", { projectRoot: realRoot, ...key, expectedRevision: null, baselineId: baseline.snapshotId, scope: ["src"], operations: changes.map((entry) => ({ op: "insert", entry })) });
  const audit = await call("compare_change_map", { projectRoot: realRoot, ...key, expectedRevision: delta.revision, baselineId: baseline.snapshotId, resultSnapshotId: baseline.snapshotId });
  const lanes = Array.from({ length: 6 }, (_, i) => ({ id: `lane-${i}`, reviewer: i === 0 ? `reviewer-${LONG.toLowerCase()}` : `reviewer-${i}`, coverage: ["src"] }));
  await review({ id: "coordinator", role: "coordinator" }, [{ op: "start_wave", id: "design-audit", mode: "design-audit", deltaRevision: delta.revision, snapshotId: baseline.snapshotId, comparisonId: audit.comparisonId, lanes }]);
  for (const lane of lanes) {
    await review({ id: lane.reviewer, role: "reviewer" }, Array.from({ length: 5 }, (_, j) => ({ op: "open_finding", lane: lane.id, localId: `F${j}`, title: j === 0 ? `${LONG} ${LONG}` : `Finding ${j} with a long title explaining what is wrong in quite some detail`, severity: ["blocker", "high", "medium", "low", "high"][j], affectedPath: `src/module-${j}/file.ts`, evidence: PARA.repeat(2), conditionToClose: PARA })));
  }

  // Children of a split cover their parent's requirements, so nested slices reuse the requirement of the slice they split.
  const slices = Array.from({ length: 16 }, (_, i) => ({ slug: `slice-${i}`, title: i === 0 ? LONG : `Slice number ${i} with a long and descriptive title that will need wrapping`, outcome: PARA, requirements: [`${requirementFiles[i < 8 ? i : 3]}#1`] }));
  await call("update_initiative", { projectRoot: realRoot, initiative: "huge-initiative", expectedRevision: null, actor: "orchestrator", operations: [
    { op: "create", slug: "huge-initiative", title: `A huge initiative with a very long title ${LONG}`, outcome: PARA.repeat(3), requirements: requirementFiles.slice(0, 8).map((file) => `${file}#1`) },
    { op: "split", parent: "huge-initiative", children: [...slices.slice(0, 8), { slug: "slice-with-long-name", title: "The slice with artifacts", outcome: PARA, requirements: [`${requirementFiles[0]}#1`] }], evidence: evidence("slice-0") },
    { op: "split", parent: "slice-3", children: slices.slice(8, 12), evidence: evidence("slice-8") },
    { op: "split", parent: "slice-8", children: slices.slice(12, 14), evidence: evidence("slice-12") },
    { op: "split", parent: "slice-12", children: slices.slice(14, 16), evidence: evidence("slice-14") },
    { op: "set_status", slug: "slice-1", status: "in-progress" },
    { op: "set_status", slug: "slice-2", status: "blocked" },
    { op: "set_status", slug: "slice-with-long-name", status: "in-progress" },
    { op: "set_dependencies", slug: "slice-2", dependencies: ["slice-1", "slice-4", "slice-5", "slice-6", "slice-7"] }
  ] });

  const operations = [
    { op: "set_serves", serves: `${PARA}${LONG}` },
    { op: "add_initiative", id: "huge-initiative", title: `A huge initiative with a very long title ${LONG}`, intent: PARA, pillar: `Pillar ${LONG}`, band: "Now", requirements: requirementFiles.slice(0, 3), rationale: PARA.repeat(2) }
  ];
  for (let i = 0; i < 28; i += 1) {
    const pillar = ["Reliability", "Compliance", "Insight", null][i % 4];
    operations.push({ op: "add_initiative", id: `initiative-${i}`, title: i === 1 ? LONG : `Initiative number ${i} with a reasonably descriptive title`, intent: i % 2 ? PARA : "Short intent.", ...(pillar ? { pillar } : {}), band: ["Now", "Next", "Later", "Parked"][i % 4], ...(i > 3 && i % 5 === 0 ? { requires: [`initiative-${i - 4}`] } : {}), ...(i % 4 === 3 ? { rationale: "Parked for now." } : {}) });
  }
  operations.push({ op: "set_open_questions", questions: Array.from({ length: 6 }, (_, i) => (i === 0 ? LONG : `${PARA}?`)) });
  const roadmap = await call("update_roadmap", { projectRoot: realRoot, expectedRevision: null, actor: "roadmap", operations });
  await call("update_roadmap", { projectRoot: realRoot, expectedRevision: roadmap.revision, actor: "orchestrator", operations: [{ op: "supersede", id: "initiative-5", by: "initiative-0", reason: PARA }] });

  await call("update_coordination_state", { projectRoot: realRoot, initiative: "huge-initiative", expectedRevision: null, changes: {
    settings: { autonomy: "broad", agentFlow: "multi", commit: "on", push: "off", continuation: "stepwise", models: "host defaults" },
    activeOperations: Array.from({ length: 4 }, (_, i) => ({ op: "start", entry: { slice: i === 0 ? "slice-with-long-name" : `slice-${i}`, activity: "design", label: i === 0 ? LONG : "Working on it", workers: Array.from({ length: 5 }, (_, j) => `worker-${i}-${j}`), workspace: realRoot } })),
    next: slices.slice(0, 10).map((slice) => `${base}/${slice.slug}`),
    evidence: [`${slicePath}/slice.md`, notesPath],
    gateOperations: Array.from({ length: 9 }, (_, i) => ({ op: "ask", kind: i % 2 ? "decision" : "visual-review", slice: i === 0 ? "slice-with-long-name" : `slice-${i}`, question: i === 0 ? `${LONG} ${PARA.repeat(3)}` : `Question ${i}: ${PARA}`, artifacts: [deltaPath, reviewPath, `${slicePath}/slice.md`, notesPath], ...(i % 2 ? { options: Array.from({ length: 5 }, (_, j) => ({ id: `option-${j}`, label: j === 0 ? LONG : `Option ${j} with a long label that wraps` })) } : {}) }))
  } });

  process.stdout.write(`Stress project: ${realRoot}\nPrivate evidence: ${dataDir}\n`);
} finally {
  close();
}
