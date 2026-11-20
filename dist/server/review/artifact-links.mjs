// Generated from src/server/review/artifact-links.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { artifactAddress, artifactLocation, artifactPathOf, locationArtifact, WORKSPACE_SCOPE } from "../workflow/artifact-paths.mjs";
const LINK = /(!?)\[([^\]]+)\]\(([^)\s]+)\)/g;
const FENCE = /^(`{3,}|~{3,})/;
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;
function linkPath(href) {
  const bare = href.split("#")[0].split("?")[0];
  if (!bare) return null;
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}
function joined(folder, target) {
  const normalized = path.posix.normalize(path.posix.join(folder, target));
  return normalized === "." || normalized === ".." || normalized.startsWith("../") ? null : normalized;
}
function markdownLinks(content) {
  const links = [];
  let fence = null;
  String(content ?? "").split(/\r?\n/).forEach((text, index) => {
    const marker = text.trim().match(FENCE);
    if (marker) {
      fence = fence === null ? marker[1][0] : fence === marker[1][0] ? null : fence;
      return;
    }
    if (fence !== null) return;
    for (const [, image, , href] of text.replace(/`[^`]+`/g, (code) => " ".repeat(code.length)).matchAll(LINK)) {
      if (!image && !NOT_RELATIVE.test(href) && !href.startsWith("//")) links.push({ line: index + 1, href });
    }
  });
  return links;
}
function checkoutPathOf(kinds, { kind, rest }) {
  const file = artifactPathOf(kinds, kind, rest);
  if (file === null) return null;
  const address = artifactAddress(kinds, file);
  return address?.kind === kind && address.rest === rest ? file : null;
}
const codeRefOf = (repository, file) => `code:${repository}:${file}`;
function parseCodeRef(ref) {
  const match = /^code:([^:/]+):(.+)$/.exec(typeof ref === "string" ? ref : "");
  return match ? { repository: match[1], path: match[2] } : null;
}
function resolveLinks({ content, location, kinds, has, repository = null, sources = null, cloned = null }) {
  const artifact = locationArtifact(location);
  const own = artifact ? checkoutPathOf(kinds, artifact) : null;
  return markdownLinks(content).map(({ line, href }) => {
    const found = resolveLink(href, { location, artifact, own, kinds, has });
    if (found?.store) return { line, href, target: found.store, resolved: true };
    if (found?.code) {
      if (repository !== null && (sources?.has(found.code) || cloned?.has(found.code))) return { line, href, target: codeRefOf(repository, found.code), resolved: true };
      if (sources === null) return { line, href, target: repository === null ? null : codeRefOf(repository, found.code), resolved: null, reason: "code_not_available" };
    }
    return { line, href, target: null, resolved: false };
  });
}
function resolveLink(href, { location, artifact, own, kinds, has }) {
  const wanted = linkPath(href);
  if (wanted === null) return null;
  const direct = joined(path.posix.dirname(location), wanted);
  if (direct !== null && has(direct)) return { store: `store:${direct}` };
  if (!artifact || own === null) return null;
  const file = joined(path.posix.dirname(own), wanted);
  if (file === null) return null;
  const address = artifactAddress(kinds, file);
  if (!address) return { code: file };
  if (address.rest === "") return null;
  for (const scope of artifact.scope.kind === "workspace" ? [WORKSPACE_SCOPE] : [artifact.scope, WORKSPACE_SCOPE]) {
    const candidate = artifactLocation(scope, address);
    if (has(candidate)) return { store: `store:${candidate}` };
  }
  return null;
}
function relativeLinkTargets(source, documentPath) {
  const targets = [];
  for (const match of (source ?? "").matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const raw = match[1].split("#")[0];
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/")) continue;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
    }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(documentPath), decoded));
    if (!target.startsWith("../")) targets.push(target);
  }
  return targets;
}
export {
  checkoutPathOf,
  codeRefOf,
  markdownLinks,
  parseCodeRef,
  relativeLinkTargets,
  resolveLinks
};
