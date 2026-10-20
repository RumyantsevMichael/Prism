import { canonical, digest } from "./conservation-store.mjs";
import type { AnalysisReceipt } from "./conservation-types.mjs";
import type { SourceRange } from "../repository-intelligence/repository-unit-types.mjs";

// The six structural discovery tools. A refactor that cites their receipts in a concept delta records a verdict for each finding in its scope.
export const DISCOVERY_TOOLS: AnalysisReceipt["tool"][] = ["find_shared_dependencies", "find_shared_literals", "find_same_name_units", "report_module_interfaces", "report_cohesion_clusters", "report_complex_units"];
// Each result list of a receipt keeps the tool's own ranking, and only this many findings of each list need a verdict.
export const REQUIRED_FINDINGS_PER_LIST = 10;
const LISTS = ["groups", "shapes", "modules", "delegatingClasses", "containers", "units"] as const;
type List = typeof LISTS[number];
export interface FindingMember { file: string; startLine: number; endLine: number }
export interface Finding { id: string; tool: AnalysisReceipt["tool"]; list: List; rank: number; members: FindingMember[] }

const ranged = (item: { file?: unknown; range?: SourceRange }): FindingMember[] => typeof item?.file === "string" && item.range ? [{ file: item.file, startLine: item.range.startLine, endLine: item.range.endLine }] : [];
type Item = Record<string, any>;

// The code that a finding names: the units of a group, the places that repeat a shape, the unused or test-only exports of a module, or the reported unit itself.
function members(list: List, item: Item): FindingMember[] {
  if (list === "groups") return [...(item.members || []), ...(item.clients || []), ...(item.variants || []).flatMap((variant: Item) => variant.members || [])].flatMap(ranged);
  if (list === "shapes") return (item.locations || []).map((location: Item) => ({ file: location.file, startLine: location.line, endLine: location.line }));
  if (list === "modules") {
    const flagged = new Set([...(item.unusedExports || []), ...(item.testOnlyExports || [])]);
    const exports: Item[] = (item.exports || []).filter((entry: Item) => !flagged.size || flagged.has(entry.name));
    return exports.flatMap(entry => ranged({ file: item.file, range: entry.range }));
  }
  return ranged(item);
}

// A finding's identity is its tool and the code it names, so two agents that cite one receipt cite the same finding whatever they call it.
export const findingId = (tool: string, list: string, found: FindingMember[]) =>
  digest(canonical([tool, list, [...found].map(member => `${member.file}:${member.startLine}-${member.endLine}`).sort()])).slice(0, 16);

export function receiptFindings(receipt: Pick<AnalysisReceipt, "tool" | List>): Finding[] {
  return LISTS.flatMap(list => ((receipt[list] || []) as Item[]).map((item, rank) => {
    const found = members(list, item);
    return { id: findingId(receipt.tool, list, found), tool: receipt.tool, list, rank, members: found };
  }));
}

// Give each reported item its finding ID, so that a verdict can cite it.
export function withFindingIds<T extends Partial<Record<List, unknown[]>>>(tool: AnalysisReceipt["tool"], results: T): T {
  const stamped = { ...results };
  for (const list of LISTS) if (Array.isArray(results[list])) (stamped as Item)[list] = (results[list] as Item[]).map(item => ({ id: findingId(tool, list, members(list, item)), ...item }));
  return stamped;
}
