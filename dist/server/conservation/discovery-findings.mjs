// Generated from src/server/conservation/discovery-findings.mts by scripts/native-build/compile.mjs.
import { canonical, digest } from "./conservation-store.mjs";
const DISCOVERY_TOOLS = ["find_shared_dependencies", "find_shared_literals", "find_same_name_units", "report_module_interfaces", "report_cohesion_clusters", "report_complex_units"];
const REQUIRED_FINDINGS_PER_LIST = 10;
const LISTS = ["groups", "shapes", "modules", "delegatingClasses", "containers", "units"];
const ranged = (item) => typeof item?.file === "string" && item.range ? [{ file: item.file, startLine: item.range.startLine, endLine: item.range.endLine }] : [];
function members(list, item) {
  if (list === "groups") return [...item.members || [], ...item.clients || [], ...(item.variants || []).flatMap((variant) => variant.members || [])].flatMap(ranged);
  if (list === "shapes") return (item.locations || []).map((location) => ({ file: location.file, startLine: location.line, endLine: location.line }));
  if (list === "modules") {
    const flagged = /* @__PURE__ */ new Set([...item.unusedExports || [], ...item.testOnlyExports || []]);
    const exports = (item.exports || []).filter((entry) => !flagged.size || flagged.has(entry.name));
    return exports.flatMap((entry) => ranged({ file: item.file, range: entry.range }));
  }
  return ranged(item);
}
const findingId = (tool, list, found) => digest(canonical([tool, list, [...found].map((member) => `${member.file}:${member.startLine}-${member.endLine}`).sort()])).slice(0, 16);
function receiptFindings(receipt) {
  return LISTS.flatMap((list) => (receipt[list] || []).map((item, rank) => {
    const found = members(list, item);
    return { id: findingId(receipt.tool, list, found), tool: receipt.tool, list, rank, members: found };
  }));
}
function withFindingIds(tool, results) {
  const stamped = { ...results };
  for (const list of LISTS) if (Array.isArray(results[list])) stamped[list] = results[list].map((item) => ({ id: findingId(tool, list, members(list, item)), ...item }));
  return stamped;
}
export {
  DISCOVERY_TOOLS,
  REQUIRED_FINDINGS_PER_LIST,
  findingId,
  receiptFindings,
  withFindingIds
};
