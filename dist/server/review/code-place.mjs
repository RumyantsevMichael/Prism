// Generated from src/server/review/code-place.mts by scripts/native-build/compile.mjs.
import { byCodePoint } from "./code-branches.mjs";
import { ownerKey } from "./code-owners.mjs";
const DAY_MS = 24 * 60 * 60 * 1e3;
const isQuiet = (branch, quietDays, now = Date.now()) => !branch.default && Math.floor((now - Date.parse(branch.committedAt)) / DAY_MS) > quietDays;
function placeAnswer({ repositories, models, preparing, owners, work, quietDays, showQuiet, now = Date.now() }) {
  const lines = [];
  for (const repository of [...models.keys()].sort(byCodePoint)) {
    for (const branch of models.get(repository).branches) {
      if (branch.default) continue;
      lines.push({ repository, branch, owners: owners.get(ownerKey(repository, branch.name)) ?? [] });
    }
  }
  const changing = lines.filter((line) => typeof line.branch.files === "number" && line.branch.files > 0);
  const entry = (line) => ({ repository: line.repository, branch: line.branch.name, base: line.branch.base, files: line.branch.files });
  const distinctFiles = (owned) => new Set(owned.flatMap((line) => line.branch.paths.map((file) => `${line.repository}\0${file}`))).size;
  const ownedBy = (initiative, slugs) => changing.filter((line) => line.owners.some((owner) => owner.initiative === initiative && slugs.has(owner.slice)));
  const below = (item, slug) => {
    const slugs = /* @__PURE__ */ new Set();
    for (const stack = [slug]; stack.length; ) {
      const next = stack.pop();
      if (slugs.has(next)) continue;
      slugs.add(next);
      stack.push(...item.children[next] ?? []);
    }
    return slugs;
  };
  const listed = /* @__PURE__ */ new Set();
  const note = (owned) => {
    for (const line of owned) listed.add(ownerKey(line.repository, line.branch.name));
    return owned;
  };
  const workAnswer = work.map((item) => {
    const all = item.root === null ? [] : ownedBy(item.initiative, below(item, item.root));
    const children = item.root === null ? [] : item.children[item.root] ?? [];
    const slices = children.map((slug) => ({ slug, owned: ownedBy(item.initiative, below(item, slug)) })).filter((slice) => slice.owned.length).map((slice) => ({ ...slice, owned: note(slice.owned) })).map(({ slug, owned }) => ({ slice: slug, title: item.titles[slug] ?? slug, files: distinctFiles(owned), branches: owned.map(entry) }));
    return { initiative: item.initiative, title: item.title, files: distinctFiles(all), slices, branches: children.length ? [] : note(all).map(entry) };
  });
  const unowned = lines.filter((line) => !line.owners.length && (typeof line.branch.files === "number" && line.branch.files > 0 || line.branch.base === null)).map((line) => ({ ...line, quiet: isQuiet(line.branch, quietDays, now) }));
  const shown = unowned.filter((line) => showQuiet || !line.quiet);
  const branches = shown.sort((left, right) => Date.parse(right.branch.committedAt) - Date.parse(left.branch.committedAt) || byCodePoint(left.repository, right.repository) || byCodePoint(left.branch.name, right.branch.name)).map((line) => {
    listed.add(ownerKey(line.repository, line.branch.name));
    return { ...entry(line), committedAt: line.branch.committedAt, people: line.branch.people, quiet: line.quiet };
  });
  return {
    lines: listed.size,
    repositories: [...repositories].sort((left, right) => byCodePoint(left.name, right.name)),
    work: workAnswer,
    branches,
    quiet: { hidden: unowned.length - shown.length, days: quietDays },
    preparing: [...preparing].sort(byCodePoint)
  };
}
export {
  isQuiet,
  placeAnswer
};
