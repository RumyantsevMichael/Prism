// Named groups of open tabs, as the review app keeps them and the review page shows them; the app and the page both read this module,
// so a group arranges its tabs the same way in every window before and after the app answers.

// A tab group's name is short text that an agent or the person gives, with its white space collapsed.
export const GROUP_NAME_LIMIT = 60;
export const GROUP_LIMIT = 32;

export function groupNameOf(value: any) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > GROUP_NAME_LIMIT) {
    throw new Error(`A tab group name must be text of 1 to ${GROUP_NAME_LIMIT} characters.`);
  }
  return name;
}

// The tabs join the named group, which is made at the end when it is new, and leave any other group; the group shows expanded.
// An opener names the agent that presented the group's tabs, and a later presentation into the group names the agent that made it.
export function joinGroup(groups: any, name: string, tabs: any, opener = null) {
  const joined = new Set(tabs);
  const others = groups.map((group: any) => group.name === name ? group : { ...group, tabs: group.tabs.filter((tab: any) => !joined.has(tab)) });
  const existing = others.find((group: any) => group.name === name);
  const by = opener ?? existing?.opener ?? null;
  const made = (groupTabs: any) => ({ name, tabs: groupTabs, collapsed: false, ...(by ? { opener: by } : {}) });
  if (!existing) return [...others, made([...tabs])];
  return others.map((group: any) => group === existing ? made([...group.tabs, ...tabs.filter((tab: any) => !group.tabs.includes(tab))]) : group);
}

// Who opened a group, as the review app records it: the harness, the model, and the claim the agent held, each only when known.
export function openerOf(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = (field: string, limit: number) => typeof value[field] === "string" && value[field].trim() && value[field].trim().length <= limit ? value[field].trim() : null;
  const opener: Record<string, any> = { host: text("host", 64), model: text("model", 128), claim: text("claim", 512) };
  for (const key of Object.keys(opener)) if (opener[key] === null) delete opener[key];
  return { agent: true, ...opener };
}

// Puts each group's tabs side by side where the group's first open tab is, in the group's own order, and drops tabs that are no longer open
// and groups left without tabs.
export function arrangeGroups(openTabs: any, groups: any) {
  const open = new Set(openTabs);
  const kept = groups.map((group: any) => ({ name: group.name, tabs: group.tabs.filter((tab: any) => open.has(tab)), collapsed: Boolean(group.collapsed), ...(group.opener ? { opener: group.opener } : {}) })).filter((group: any) => group.tabs.length);
  const groupOf = new Map(kept.flatMap((group: any) => group.tabs.map((tab: any) => [tab, group])));
  const arranged: any[] = [];
  const placed = new Set();
  for (const tab of openTabs) {
    const group: any = groupOf.get(tab);
    if (!group) arranged.push(tab);
    else if (!placed.has(group)) {
      placed.add(group);
      arranged.push(...group.tabs);
    }
  }
  // A group's own tab order follows the strip, so the order the strip shows is the order every window keeps.
  return { openTabs: arranged, groups: [...placed].map((group) => ({ ...(group as any), tabs: arranged.filter((tab) => groupOf.get(tab) === group) })) };
}
