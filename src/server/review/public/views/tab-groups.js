// Named groups of open tabs, as the review app keeps them and the review page shows them; the app and the page both read this module,
// so a group arranges its tabs the same way in every window before and after the app answers.

// A tab group's name is short text that an agent or the person gives, with its white space collapsed.
export const GROUP_NAME_LIMIT = 60;
export const GROUP_LIMIT = 32;

export function groupNameOf(value) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > GROUP_NAME_LIMIT) {
    throw new Error(`A tab group name must be text of 1 to ${GROUP_NAME_LIMIT} characters.`);
  }
  return name;
}

// The tabs join the named group, which is made at the end when it is new, and leave any other group; the group shows expanded.
export function joinGroup(groups, name, tabs) {
  const joined = new Set(tabs);
  const others = groups.map((group) => group.name === name ? group : { ...group, tabs: group.tabs.filter((tab) => !joined.has(tab)) });
  const existing = others.find((group) => group.name === name);
  if (!existing) return [...others, { name, tabs: [...tabs], collapsed: false }];
  return others.map((group) => group === existing ? { name, tabs: [...group.tabs, ...tabs.filter((tab) => !group.tabs.includes(tab))], collapsed: false } : group);
}

// Puts each group's tabs side by side where the group's first open tab is, in the group's own order, and drops tabs that are no longer open
// and groups left without tabs.
export function arrangeGroups(openTabs, groups) {
  const open = new Set(openTabs);
  const kept = groups.map((group) => ({ name: group.name, tabs: group.tabs.filter((tab) => open.has(tab)), collapsed: Boolean(group.collapsed) })).filter((group) => group.tabs.length);
  const groupOf = new Map(kept.flatMap((group) => group.tabs.map((tab) => [tab, group])));
  const arranged = [];
  const placed = new Set();
  for (const tab of openTabs) {
    const group = groupOf.get(tab);
    if (!group) arranged.push(tab);
    else if (!placed.has(group)) {
      placed.add(group);
      arranged.push(...group.tabs);
    }
  }
  // A group's own tab order follows the strip, so the order the strip shows is the order every window keeps.
  return { openTabs: arranged, groups: [...placed].map((group) => ({ ...group, tabs: arranged.filter((tab) => groupOf.get(tab) === group) })) };
}
