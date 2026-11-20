// Generated from src/server/review/public/views/tab-groups.ts by scripts/native-build/compile.mjs.
const GROUP_NAME_LIMIT = 60;
const GROUP_LIMIT = 32;
function groupNameOf(value) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > GROUP_NAME_LIMIT) {
    throw new Error(`A tab group name must be text of 1 to ${GROUP_NAME_LIMIT} characters.`);
  }
  return name;
}
function joinGroup(groups, name, tabs, opener = null) {
  const joined = new Set(tabs);
  const others = groups.map((group) => group.name === name ? group : { ...group, tabs: group.tabs.filter((tab) => !joined.has(tab)) });
  const existing = others.find((group) => group.name === name);
  const by = opener ?? existing?.opener ?? null;
  const made = (groupTabs) => ({ name, tabs: groupTabs, collapsed: false, ...by ? { opener: by } : {} });
  if (!existing) return [...others, made([...tabs])];
  return others.map((group) => group === existing ? made([...group.tabs, ...tabs.filter((tab) => !group.tabs.includes(tab))]) : group);
}
function openerOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = (field, limit) => typeof value[field] === "string" && value[field].trim() && value[field].trim().length <= limit ? value[field].trim() : null;
  const opener = { host: text("host", 64), model: text("model", 128), claim: text("claim", 512) };
  for (const key of Object.keys(opener)) if (opener[key] === null) delete opener[key];
  return { agent: true, ...opener };
}
function arrangeGroups(openTabs, groups) {
  const open = new Set(openTabs);
  const kept = groups.map((group) => ({ name: group.name, tabs: group.tabs.filter((tab) => open.has(tab)), collapsed: Boolean(group.collapsed), ...group.opener ? { opener: group.opener } : {} })).filter((group) => group.tabs.length);
  const groupOf = new Map(kept.flatMap((group) => group.tabs.map((tab) => [tab, group])));
  const arranged = [];
  const placed = /* @__PURE__ */ new Set();
  for (const tab of openTabs) {
    const group = groupOf.get(tab);
    if (!group) arranged.push(tab);
    else if (!placed.has(group)) {
      placed.add(group);
      arranged.push(...group.tabs);
    }
  }
  return { openTabs: arranged, groups: [...placed].map((group) => ({ ...group, tabs: arranged.filter((tab) => groupOf.get(tab) === group) })) };
}
export {
  GROUP_LIMIT,
  GROUP_NAME_LIMIT,
  arrangeGroups,
  groupNameOf,
  joinGroup,
  openerOf
};
